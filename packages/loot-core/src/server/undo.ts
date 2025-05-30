// @ts-strict-ignore
import { Timestamp } from '@actual-app/crdt';

import * as connection from '../platform/server/connection';
import { getIn } from '../shared/util';
import { type HandlerFunctions } from '../types/handlers';

import { withMutatorContext, getMutatorContext } from './mutators';
import { Message, sendMessages } from './sync';

// A marker always sits as the first entry to simplify logic
type MarkerMessage = { type: 'marker'; meta?: unknown };
type MessagesMessage = {
  type: 'messages';
  messages: Message[];
  meta?: unknown;
  oldData;
  undoTag;
};
let MESSAGE_HISTORY: Array<MarkerMessage | MessagesMessage> = [
  { type: 'marker' },
];
let CURSOR = 0;
const HISTORY_SIZE = 20;

export type UndoState = {
  messages: Message[];
  meta?: unknown;
  tables: string[];
  undoTag: string;
};

function trimHistory() {
  MESSAGE_HISTORY = MESSAGE_HISTORY.slice(0, CURSOR + 1);

  const markers = MESSAGE_HISTORY.filter(item => item.type === 'marker');
  if (markers.length > HISTORY_SIZE) {
    const slice = markers.slice(-HISTORY_SIZE);
    const cutoff = MESSAGE_HISTORY.indexOf(slice[0]);
    MESSAGE_HISTORY = MESSAGE_HISTORY.slice(cutoff);
    CURSOR = MESSAGE_HISTORY.length - 1;
  }
}

export function appendMessages(messages, oldData) {
  const context = getMutatorContext();

  if (context.undoListening && messages.length > 0) {
    trimHistory();

    const { undoTag } = context;

    MESSAGE_HISTORY.push({
      type: 'messages',
      messages,
      oldData,
      undoTag,
    });
    CURSOR++;
  }
}

export function clearUndo() {
  MESSAGE_HISTORY = [{ type: 'marker' }];
  CURSOR = 0;
}

export function withUndo<T>(
  func: () => Promise<T>,
  meta?: unknown,
): Promise<T> {
  const context = getMutatorContext();
  if (context.undoDisabled || context.undoListening) {
    return func();
  }

  MESSAGE_HISTORY = MESSAGE_HISTORY.slice(0, CURSOR + 1);

  const marker: MarkerMessage = { type: 'marker', meta };

  if (MESSAGE_HISTORY[MESSAGE_HISTORY.length - 1].type === 'marker') {
    MESSAGE_HISTORY[MESSAGE_HISTORY.length - 1] = marker;
  } else {
    MESSAGE_HISTORY.push(marker);
    CURSOR++;
  }

  return withMutatorContext(
    { undoListening: true, undoTag: context.undoTag },
    func,
  );
}

export function undoable<T extends HandlerFunctions>(
  func: T,
  metaFunc?: (...metaArgs: Parameters<T>) => unknown,
) {
  return (...args: Parameters<T>) => {
    return withUndo<Awaited<ReturnType<T>>>(
      () => {
        return func.apply(null, args);
      },
      metaFunc ? metaFunc(...args) : undefined,
    );
  };
}

async function applyUndoAction(messages, meta, undoTag) {
  await withMutatorContext({ undoListening: false }, () => {
    return sendMessages(
      messages.map(msg => ({ ...msg, timestamp: Timestamp.send() })),
    );
  });

  const tables = messages.reduce((acc, message) => {
    if (!acc.includes(message.dataset)) {
      acc.push(message.dataset);
    }
    return acc;
  }, []);

  connection.send('undo-event', {
    messages,
    tables,
    meta,
    undoTag,
  });
}

export async function undo() {
  const end = CURSOR;
  CURSOR = Math.max(CURSOR - 1, 0);

  // Walk back to the nearest marker
  while (CURSOR > 0 && MESSAGE_HISTORY[CURSOR].type !== 'marker') {
    CURSOR--;
  }

  const meta = MESSAGE_HISTORY[CURSOR].meta;
  const start = Math.max(CURSOR, 0);
  const entries = MESSAGE_HISTORY.slice(start, end + 1).filter(
    (entry): entry is MessagesMessage => entry.type === 'messages',
  );

  if (entries.length > 0) {
    const toApply = entries
      .reduce((acc, entry) => {
        return acc.concat(
          entry.messages
            .map(message => undoMessage(message, entry.oldData))
            .filter(x => x),
        );
      }, [])
      .reverse();

    await applyUndoAction(toApply, meta, entries[0].undoTag);
  }
}

function undoMessage(message, oldData) {
  const oldItem = getIn(oldData, [message.dataset, message.row]);
  if (oldItem) {
    let column = message.column;
    if (message.dataset === 'spreadsheet_cells') {
      // The spreadsheet messages use the `expr` column, but only as a
      // placeholder. We actually want to read the `cachedValue` prop
      // from the old item.
      column = 'cachedValue';
    }

    return { ...message, value: oldItem[column] };
  } else {
    if (message.dataset === 'spreadsheet_cells') {
      if (message.column === 'expr') {
        return { ...message, value: null };
      }
      return message;
    } else if (
      // The mapping fields aren't ever deleted... this should be
      // harmless since all they are is meta information. Maybe we
      // should fix this though.
      message.dataset !== 'category_mapping' &&
      message.dataset !== 'payee_mapping'
    ) {
      if (
        message.dataset === 'zero_budget_months' ||
        message.dataset === 'zero_budgets' ||
        message.dataset === 'reflect_budgets'
      ) {
        // Only these fields are reversable
        if (['buffered', 'amount', 'carryover'].includes(message.column)) {
          return { ...message, value: 0 };
        }
        return null;
      } else if (message.dataset === 'notes') {
        return { ...message, value: null };
      }

      return { ...message, column: 'tombstone', value: 1 };
    }
  }
  return null;
}

export async function redo() {
  const meta =
    MESSAGE_HISTORY[CURSOR].type === 'marker'
      ? MESSAGE_HISTORY[CURSOR].meta
      : null;

  const start = CURSOR;
  CURSOR = Math.min(CURSOR + 1, MESSAGE_HISTORY.length - 1);

  // Walk forward to the nearest marker
  while (
    CURSOR < MESSAGE_HISTORY.length - 1 &&
    MESSAGE_HISTORY[CURSOR].type !== 'marker'
  ) {
    CURSOR++;
  }

  const end = CURSOR;
  const entries = MESSAGE_HISTORY.slice(start + 1, end + 1).filter(
    (entry): entry is MessagesMessage => entry.type === 'messages',
  );

  if (entries.length > 0) {
    const toApply = entries.reduce((acc, entry) => {
      return acc
        .concat(entry.messages)
        .concat(redoResurrections(entry.messages, entry.oldData));
    }, []);

    await applyUndoAction(toApply, meta, entries[entries.length - 1].undoTag);
  }
}

function redoResurrections(messages, oldData): Message[] {
  const resurrect = new Set<string>();

  messages.forEach(message => {
    // If any of the ids didn't exist before, we need to "resurrect"
    // them by resetting their tombstones to 0
    const oldItem = getIn(oldData, [message.dataset, message.row]);
    if (
      !oldItem &&
      ![
        'zero_budget_months',
        'zero_budgets',
        'reflect_budgets',
        'notes',
        'category_mapping',
        'payee_mapping',
      ].includes(message.dataset)
    ) {
      resurrect.add(message.dataset + '.' + message.row);
    }
  });

  return [...resurrect].map(desc => {
    const [table, row] = desc.split('.');
    return {
      dataset: table,
      row,
      column: 'tombstone',
      value: 0,
      timestamp: Timestamp.send(),
    };
  });
}
