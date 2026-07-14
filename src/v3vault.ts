/*
 * V3Vault Event Handlers
 * Mirrors original subgraph structure: vault-graph-main/src/v3vault.ts
 */
import { indexer, BigDecimal, Vault, Loan, Lender, LoanSnapshot, LenderSnapshot, handlerContext } from "envio";
import { Liquidation_t } from "generated/src/db/Entities.gen";
import { getVaultMetadata, getLoanInfo, getLendInfo } from "./effects/v3vaultEffects";

// Constants
const ZERO_BI = 0n;
const Q96 = BigInt(2 ** 96);

/**
 * Helper function to convert BigInt to bytes for ID generation
 * No dependencies - can be implemented immediately
 */
function getBytes(number: bigint): string {
  return number.toString();
}

/**
 * Get or create Vault entity with RPC calls for metadata
 */
async function getVault(vaultAddress: string, chainId: number, context: handlerContext): Promise<Vault> {
  const vaultId = `${chainId}-${vaultAddress}`;
  let vault = await context.Vault.get(vaultId);
  
  if (!vault) {
    // Fetch vault metadata using Effect API
    const metadata = await context.effect(getVaultMetadata, {
      vaultAddress,
      chainId,
    });

    vault = {
      id: vaultId,
      asset: metadata.asset,
      decimals: BigInt(metadata.decimals),
    };
    context.Vault.set(vault);
  }
  
  return vault;
}

/**
 * Get or create Loan entity
 */
async function getLoan(tokenId: bigint, vaultAddress: string, chainId: number, context: handlerContext): Promise<Loan> {
  const loanId = `${chainId}-${getBytes(tokenId)}-${vaultAddress}`;
  let loan = await context.Loan.get(loanId);
  
  if (!loan) {
    const vault = await getVault(vaultAddress, chainId, context);
    
    loan = {
      id: loanId,
      tokenId: tokenId,
      vault_id: vault.id,
      shares: ZERO_BI,
      owner: "",
      previousLoan: undefined,
      isExited: false,
    };
  }
  
  return loan;
}

/**
 * Get or create Lender entity
 */
async function getLender(address: string, vaultAddress: string, chainId: number, context: handlerContext): Promise<Lender> {
  const lenderId = `${chainId}-${address}-${vaultAddress}`;
  let lender = await context.Lender.get(lenderId);
  
  if (!lender) {
    const vault = await getVault(vaultAddress, chainId, context);
    
    lender = {
      id: lenderId,
      address: address,
      vault_id: vault.id,
      shares: ZERO_BI,
    };
  }
  
  return lender;
}

/**
 * Create loan snapshot with RPC call for loan info
 * Max 1 snapshot per block is saved
 */
async function createLoanSnapshot(
  loan: Loan,
  vaultAddress: string,
  chainId: number,
  blockNumber: number,
  blockTimestamp: number,
  transactionHash: string,
  context: handlerContext,
  isRemoveEvent: boolean = false,
  amountRepaid: bigint | undefined = undefined,
  amountBorrowed: bigint | undefined = undefined
): Promise<void> {
  const snapshotId = `${loan.id}-${vaultAddress}-${blockNumber}`;

  const baseSnapshot = {
    id: snapshotId,
    loan_id: loan.id,
    shares: loan.shares,
    owner: loan.owner,
    blockNumber: BigInt(blockNumber),
    blockTimestamp: BigInt(blockTimestamp),
    transactionHash,
    amountRepaid,
    amountBorrowed,
  } satisfies Omit<LoanSnapshot, "debt" | "collateralValue" | "fullValue">;

  // Try to get loan info using Effect API
  const loanInfo = await context.effect(getLoanInfo, {
    vaultAddress,
    tokenId: loan.tokenId.toString(),
    chainId,
  });

  if (loanInfo) {
    // Normal case - we got valid loan info
    const snapshot: LoanSnapshot = {
      ...baseSnapshot,
      debt: BigInt(loanInfo.debt),
      collateralValue: BigInt(loanInfo.collateralValue),
      fullValue: BigInt(loanInfo.fullValue),
    };
    context.LoanSnapshot.set(snapshot);
    return;
  }

  // The loan info call reverted (loanInfo is undefined)
  if (isRemoveEvent) {
    const snapshot: LoanSnapshot = {
      ...baseSnapshot,
      debt: ZERO_BI,
      collateralValue: ZERO_BI,
      fullValue: ZERO_BI,
    };
    context.LoanSnapshot.set(snapshot);
  }
}

/**
 * Create lender snapshot with RPC call for lend info
 * Max 1 snapshot per block is saved
 */
async function createLenderSnapshot(
  lender: Lender,
  vaultAddress: string,
  chainId: number,
  blockNumber: number,
  blockTimestamp: number,
  transactionHash: string,
  context: handlerContext
): Promise<void> {
  const snapshotId = `${lender.id}-${vaultAddress}-${blockNumber}`;

  // Get current lent amount using Effect API
  const lent = await context.effect(getLendInfo, {
    vaultAddress,
    lenderAddress: lender.address,
    chainId,
  });

  const snapshot: LenderSnapshot = {
    id: snapshotId,
    lender_id: lender.id,
    lent: BigInt(lent),
    shares: lender.shares,
    blockNumber: BigInt(blockNumber),
    blockTimestamp: BigInt(blockTimestamp),
    transactionHash: transactionHash,
  };

  context.LenderSnapshot.set(snapshot);
}

indexer.onEvent(
  { contract: "V3Vault", event: "Add" },
  async ({ event, context }) => {
  const loan = await getLoan(
    event.params.tokenId,
    event.srcAddress,
    event.chainId,
    context
  );

  let updatedLoan: Loan = {
    ...loan,
    previousLoan: undefined,
    shares: ZERO_BI,
  };

  if (event.params.oldTokenId > ZERO_BI) {
    const oldLoanId = `${event.chainId}-${getBytes(
      event.params.oldTokenId
    )}-${event.srcAddress}`;
    const oldLoan = await context.Loan.get(oldLoanId);
    updatedLoan = {
      ...updatedLoan,
      shares: oldLoan ? oldLoan.shares : ZERO_BI,
      previousLoan: oldLoan ? oldLoan.id : undefined,
    };
  }

  updatedLoan = {
    ...updatedLoan,
    owner: event.params.owner,
  };

  context.Loan.set(updatedLoan);

  await createLoanSnapshot(
    updatedLoan,
    event.srcAddress,
    event.chainId,
    Number(event.block.number),
    Number(event.block.timestamp),
    event.transaction.hash,
    context,
    false
  );
}
);

indexer.onEvent(
  { contract: "V3Vault", event: "Remove" },
  async ({ event, context }) => {
  const loan = await getLoan(
    event.params.tokenId,
    event.srcAddress,
    event.chainId,
    context
  );

  const updatedLoan: Loan = {
    ...loan,
    isExited: true,
  };

  context.Loan.set(updatedLoan);

  await createLoanSnapshot(
    updatedLoan,
    event.srcAddress,
    event.chainId,
    Number(event.block.number),
    Number(event.block.timestamp),
    event.transaction.hash,
    context,
    true
  );
}
);

indexer.onEvent(
  { contract: "V3Vault", event: "Borrow" },
  async ({ event, context }) => {
  const loan = await getLoan(
    event.params.tokenId,
    event.srcAddress,
    event.chainId,
    context
  );

  const updatedLoan: Loan = {
    ...loan,
    shares: loan.shares + event.params.shares,
  };

  context.Loan.set(updatedLoan);

  await createLoanSnapshot(
    updatedLoan,
    event.srcAddress,
    event.chainId,
    Number(event.block.number),
    Number(event.block.timestamp),
    event.transaction.hash,
    context,
    false,
    undefined,
    event.params.assets
  );
}
);

indexer.onEvent(
  { contract: "V3Vault", event: "Deposit" },
  async ({ event, context }) => {
  const lender = await getLender(
    event.params.owner,
    event.srcAddress,
    event.chainId,
    context
  );

  const updatedLender: Lender = {
    ...lender,
    shares: lender.shares + event.params.shares,
  };

  context.Lender.set(updatedLender);

  await createLenderSnapshot(
    updatedLender,
    event.srcAddress,
    event.chainId,
    Number(event.block.number),
    Number(event.block.timestamp),
    event.transaction.hash,
    context
  );
}
);

indexer.onEvent(
  { contract: "V3Vault", event: "ExchangeRateUpdate" },
  async ({ event, context }) => {
  const timestamp = Number(event.block.timestamp);
  const dayID = `${event.chainId}-${event.srcAddress}-${Math.floor(timestamp / 86400)}`;
  const hourID = `${event.chainId}-${event.srcAddress}-${Math.floor(timestamp / 3600)}`;

  // Load or create daily exchange rate
  let daily = await context.DailyExchangeRate.get(dayID);
  if (!daily) {
    // Convert to BigDecimal by dividing by Q96
    const debtExchangeRate = new BigDecimal(event.params.debtExchangeRateX96.toString()).div(new BigDecimal(Q96.toString()));
    const lendExchangeRate = new BigDecimal(event.params.lendExchangeRateX96.toString()).div(new BigDecimal(Q96.toString()));

    daily = {
      id: dayID,
      day: BigInt(Math.floor(timestamp / 86400)),
      vault_id: `${event.chainId}-${event.srcAddress}`,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      debtExchangeRate: debtExchangeRate,
      lendExchangeRate: lendExchangeRate,
    };
    context.DailyExchangeRate.set(daily);
  }

  // Load or create hourly exchange rate
  let hourly = await context.HourlyExchangeRate.get(hourID);
  if (!hourly) {
    // Convert to BigDecimal by dividing by Q96
    const debtExchangeRate = new BigDecimal(event.params.debtExchangeRateX96.toString()).div(new BigDecimal(Q96.toString()));
    const lendExchangeRate = new BigDecimal(event.params.lendExchangeRateX96.toString()).div(new BigDecimal(Q96.toString()));

    hourly = {
      id: hourID,
      hour: BigInt(Math.floor(timestamp / 3600)),
      vault_id: `${event.chainId}-${event.srcAddress}`,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
      debtExchangeRate: debtExchangeRate,
      lendExchangeRate: lendExchangeRate,
    };
    context.HourlyExchangeRate.set(hourly);
  }
}
);

indexer.onEvent(
  { contract: "V3Vault", event: "Liquidate" },
  async ({ event, context }) => {
  const loan = await getLoan(
    event.params.tokenId,
    event.srcAddress,
    event.chainId,
    context
  );

  const liquidationId = `${event.chainId}-${event.transaction.hash}-${event.logIndex}`;

  const liquidation: Liquidation_t = {
    id: liquidationId,
    loan_id: loan.id,
    liquidator: event.params.liquidator,
    owner: event.params.owner,
    value: event.params.value,
    cost: event.params.cost,
    amount0: event.params.amount0,
    amount1: event.params.amount1,
    reserve: event.params.reserve,
    missing: event.params.missing,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
    transactionHash: event.transaction.hash,
  };

  context.Liquidation.set(liquidation);
}
);

indexer.onEvent(
  { contract: "V3Vault", event: "Repay" },
  async ({ event, context }) => {
  const loan = await getLoan(
    event.params.tokenId,
    event.srcAddress,
    event.chainId,
    context
  );

  const updatedLoan: Loan = {
    ...loan,
    shares: loan.shares - event.params.shares,
  };

  context.Loan.set(updatedLoan);

  await createLoanSnapshot(
    updatedLoan,
    event.srcAddress,
    event.chainId,
    Number(event.block.number),
    Number(event.block.timestamp),
    event.transaction.hash,
    context,
    false,
    event.params.assets,
    undefined
  );
}
);

indexer.onEvent(
  { contract: "V3Vault", event: "Withdraw" },
  async ({ event, context }) => {
  const lender = await getLender(
    event.params.owner,
    event.srcAddress,
    event.chainId,
    context
  );

  const updatedLender: Lender = {
    ...lender,
    shares: lender.shares - event.params.shares,
  };

  context.Lender.set(updatedLender);

  await createLenderSnapshot(
    updatedLender,
    event.srcAddress,
    event.chainId,
    Number(event.block.number),
    Number(event.block.timestamp),
    event.transaction.hash,
    context
  );
}
);

indexer.onEvent(
  { contract: "V3Vault", event: "WithdrawCollateral" },
  async ({ event, context }) => {
  const loan = await getLoan(
    event.params.tokenId,
    event.srcAddress,
    event.chainId,
    context
  );

  await createLoanSnapshot(
    loan,
    event.srcAddress,
    event.chainId,
    Number(event.block.number),
    Number(event.block.timestamp),
    event.transaction.hash,
    context
  );
}
);

