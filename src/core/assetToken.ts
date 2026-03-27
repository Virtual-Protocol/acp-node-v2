import { Address, parseUnits } from "viem";
import type { AcpClient } from "../clientFactory";
import { USDC_ADDRESSES, USDC_DECIMALS, USDC_SYMBOL, getAddressForChain } from "./constants";

export class AssetToken {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly amount: number;
  readonly rawAmount: bigint;

  constructor(address: Address, symbol: string, decimals: number, amount: number) {
    this.address = address;
    this.symbol = symbol;
    this.decimals = decimals;
    this.amount = amount;
    this.rawAmount = parseUnits(amount.toString(), decimals);
  }

  static create(
    address: Address,
    symbol: string,
    decimals: number,
    amount: number
  ): AssetToken {
    return new AssetToken(address, symbol, decimals, amount);
  }

  static usdc(amount: number, chainId: number): AssetToken {
    const address = getAddressForChain(USDC_ADDRESSES, chainId, "USDC");
    return new AssetToken(address, USDC_SYMBOL, USDC_DECIMALS, amount);
  }

  static usdcFromRaw(rawAmount: bigint, chainId: number): AssetToken {
    const address = getAddressForChain(USDC_ADDRESSES, chainId, "USDC");
    const dec = Number(rawAmount) / 10 ** USDC_DECIMALS;
    return new AssetToken(address, USDC_SYMBOL, USDC_DECIMALS, dec);
  }

  static async fromOnChain(
    address: Address,
    amount: number,
    chainId: number,
    client: AcpClient
  ): Promise<AssetToken> {
    if (address === USDC_ADDRESSES[chainId]) {
      return AssetToken.usdc(amount, chainId);
    }

    const [decimals, symbol] = await Promise.all([
      client.getTokenDecimals(chainId, address),
      client.getTokenSymbol(chainId, address),
    ]);
    return new AssetToken(address, symbol, decimals, amount);
  }

  static async fromOnChainRaw(
    address: Address,
    rawAmount: bigint,
    chainId: number,
    client: AcpClient
  ): Promise<AssetToken> {
    if (address === USDC_ADDRESSES[chainId]) {
      return AssetToken.usdcFromRaw(rawAmount, chainId);
    }

    const [decimals, symbol] = await Promise.all([
      client.getTokenDecimals(chainId, address),
      client.getTokenSymbol(chainId, address),
    ]);
    return new AssetToken(
      address,
      symbol,
      decimals,
      Number(rawAmount) / 10 ** decimals
    );
  }
}
