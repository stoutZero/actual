import React, { useState } from 'react';
import { Trans } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgCheckCircle1 } from '@actual-app/components/icons/v2';
import { InitialFocus } from '@actual-app/components/initial-focus';
import { Input } from '@actual-app/components/input';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { t } from 'i18next';

import * as queries from 'loot-core/client/queries';
import { type Query } from 'loot-core/shared/query';
import { currencyToInteger, tsToRelativeTime } from 'loot-core/shared/util';
import { type AccountEntity } from 'loot-core/types/models';
import { type TransObjectLiteral } from 'loot-core/types/util';

import { useLocale } from '../../hooks/useLocale';
import { useFormat } from '../spreadsheet/useFormat';
import { useSheetValue } from '../spreadsheet/useSheetValue';

type ReconcilingMessageProps = {
  balanceQuery: { name: `balance-query-${string}`; query: Query };
  targetBalance: number;
  onDone: () => void;
  onCreateTransaction: (targetDiff: number) => void;
};

export function ReconcilingMessage({
  balanceQuery,
  targetBalance,
  onDone,
  onCreateTransaction,
}: ReconcilingMessageProps) {
  const cleared =
    useSheetValue<'balance', `balance-query-${string}-cleared`>({
      name: (balanceQuery.name +
        '-cleared') as `balance-query-${string}-cleared`,
      value: 0,
      query: balanceQuery.query.filter({ cleared: true }),
    }) ?? 0;
  const format = useFormat();
  const targetDiff = targetBalance - cleared;

  const clearedBalance = format(cleared, 'financial');
  const bankBalance = format(targetBalance, 'financial');
  const difference =
    (targetDiff > 0 ? '+' : '') + format(targetDiff, 'financial');

  return (
    <View
      style={{
        flexDirection: 'row',
        alignSelf: 'center',
        backgroundColor: theme.tableBackground,
        ...styles.shadow,
        borderRadius: 4,
        marginTop: 5,
        marginBottom: 15,
        padding: 10,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {targetDiff === 0 ? (
          <View
            style={{
              color: theme.noticeTextLight,
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <SvgCheckCircle1
              style={{
                width: 13,
                height: 13,
                color: 'inherit',
                marginRight: 3,
              }}
            />
            <Trans>All reconciled!</Trans>
          </View>
        ) : (
          <View style={{ color: theme.tableText }}>
            <Text style={{ fontStyle: 'italic', textAlign: 'center' }}>
              <Trans>
                Your cleared balance{' '}
                <strong>{{ clearedBalance } as TransObjectLiteral}</strong>{' '}
                needs <strong>{{ difference } as TransObjectLiteral}</strong> to
                match
                <br /> your bank&apos;s balance of{' '}
                <Text style={{ fontWeight: 700 }}>
                  {{ bankBalance } as TransObjectLiteral}
                </Text>
              </Trans>
            </Text>
          </View>
        )}
        <View style={{ marginLeft: 15 }}>
          <Button variant="primary" onPress={onDone}>
            <Trans>Done reconciling</Trans>
          </Button>
        </View>
        {targetDiff !== 0 && (
          <View style={{ marginLeft: 15 }}>
            <Button onPress={() => onCreateTransaction(targetDiff)}>
              <Trans>Create reconciliation transaction</Trans>
            </Button>
          </View>
        )}
      </View>
    </View>
  );
}

type ReconcileMenuProps = {
  account: AccountEntity;
  onReconcile: (amount: number | null) => void;
  onClose: () => void;
};

export function ReconcileMenu({
  account,
  onReconcile,
  onClose,
}: ReconcileMenuProps) {
  const balanceQuery = queries.accountBalance(account);
  const clearedBalance = useSheetValue<'account', `balance-${string}-cleared`>({
    name: (balanceQuery.name + '-cleared') as `balance-${string}-cleared`,
    value: null,
    query: balanceQuery.query.filter({ cleared: true }),
  });
  const format = useFormat();
  const locale = useLocale();
  const [inputValue, setInputValue] = useState<string | null>(null);

  function onSubmit() {
    if (inputValue === '') {
      return;
    }

    const amount =
      inputValue != null ? currencyToInteger(inputValue) : clearedBalance;

    onReconcile(amount);
    onClose();
  }

  return (
    <View style={{ padding: '5px 8px' }}>
      <Text>
        <Trans>
          Enter the current balance of your bank account that you want to
          reconcile with:
        </Trans>
      </Text>
      {clearedBalance != null && (
        <InitialFocus>
          <Input
            defaultValue={format(clearedBalance, 'financial')}
            onChangeValue={setInputValue}
            style={{ margin: '7px 0' }}
            onEnter={onSubmit}
          />
        </InitialFocus>
      )}
      <Text style={{ color: theme.pageTextSubdued, paddingBottom: 6 }}>
        {account?.last_reconciled
          ? t('Reconciled {{ relativeTimeAgo }}', {
              relativeTimeAgo: tsToRelativeTime(
                account.last_reconciled,
                locale,
              ),
            })
          : t('Not yet reconciled')}
      </Text>
      <Button variant="primary" onPress={onSubmit}>
        <Trans>Reconcile</Trans>
      </Button>
    </View>
  );
}
