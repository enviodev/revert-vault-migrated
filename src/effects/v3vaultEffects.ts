/*
 * Effect API functions for V3Vault contract state fetching
 * All RPC calls must use Effect API when preload_handlers is enabled
 */
import { createEffect, S } from "envio";
import { createPublicClient, http, parseAbi } from "viem";

// V3Vault ABI for the functions we need
const V3VAULT_ABI = parseAbi([
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function loanInfo(uint256 tokenId) view returns (uint256 debt, uint256 collateralValue, uint256 fullValue)",
  "function lendInfo(address lender) view returns (uint256 amount)",
]);

// Create public client for RPC calls with transport batching enabled
// Note: In multichain setup, you'd need to dynamically select the RPC URL based on chainId
const getPublicClient = (chainId: number) => {
  const rpcUrls: { [key: number]: string } = {
    1: process.env.RPC_URL_1 || "",
    8453: process.env.RPC_URL_8453 || "",
    42161: process.env.RPC_URL_42161 || "",
  };

  return createPublicClient({
    transport: http(rpcUrls[chainId], {
      batch: true, // Enable transport batching for better performance
    }),
  });
};

/**
 * Fetch V3Vault asset and decimals
 */
export const getVaultMetadata = createEffect(
  {
    name: "getVaultMetadata",
    input: S.schema({
      vaultAddress: S.string,
      chainId: S.number,
    }),
    output: S.schema({
      asset: S.string,
      decimals: S.number,
    }),
    rateLimit: false,
    cache: true,
  },
  async ({ input, context }) => {
    const publicClient = getPublicClient(input.chainId);

    try {
      const [asset, decimals] = await Promise.all([
        publicClient.readContract({
          address: input.vaultAddress as `0x${string}`,
          abi: V3VAULT_ABI,
          functionName: "asset",
        }),
        publicClient.readContract({
          address: input.vaultAddress as `0x${string}`,
          abi: V3VAULT_ABI,
          functionName: "decimals",
        }),
      ]);

      return {
        asset: asset as string,
        decimals: Number(decimals),
      };
    } catch (error) {
      context.log.error(`Error fetching vault metadata for ${input.vaultAddress}: ${error}`);
      throw error;
    }
  }
);

/**
 * Fetch loan info for a specific token ID
 * Returns undefined if the call reverts (loan doesn't exist or was removed)
 */
export const getLoanInfo = createEffect(
  {
    name: "getLoanInfo",
    input: S.schema({
      vaultAddress: S.string,
      tokenId: S.string,
      chainId: S.number,
    }),
    output: S.nullable(
      S.schema({
        debt: S.string,
        collateralValue: S.string,
        fullValue: S.string,
      })
    ),
    rateLimit: false,
    cache: false, // Don't cache as loan state changes
  },
  async ({ input, context }) => {
    const publicClient = getPublicClient(input.chainId);

    try {
      const result = await publicClient.readContract({
        address: input.vaultAddress as `0x${string}`,
        abi: V3VAULT_ABI,
        functionName: "loanInfo",
        args: [BigInt(input.tokenId)],
      });

      return {
        debt: (result[0] as bigint).toString(),
        fullValue: (result[1] as bigint).toString(),
        collateralValue: (result[2] as bigint).toString(),
      };
    } catch (error) {
      // Loan info call reverted - this is expected for removed loans
      return undefined;
    }
  }
);

/**
 * Fetch lend info for a specific lender address
 */
export const getLendInfo = createEffect(
  {
    name: "getLendInfo",
    input: S.schema({
      vaultAddress: S.string,
      lenderAddress: S.string,
      chainId: S.number,
    }),
    output: S.string, // Amount as string
    rateLimit: false,
    cache: false, // Don't cache as lend state changes
  },
  async ({ input, context }) => {
    const publicClient = getPublicClient(input.chainId);

    try {
      const amount = await publicClient.readContract({
        address: input.vaultAddress as `0x${string}`,
        abi: V3VAULT_ABI,
        functionName: "lendInfo",
        args: [input.lenderAddress as `0x${string}`],
      });

      return (amount as bigint).toString();
    } catch (error) {
      context.log.error(`Error fetching lend info for ${input.lenderAddress}: ${error}`);
      return "0";
    }
  }
);

