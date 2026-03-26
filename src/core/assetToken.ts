import { Address, parseUnits } from "viem";
import type { AcpClient } from "../clientFactory";
import { USDC_ADDRESSES, USDC_DECIMALS, getAddressForChain } from "./constants";

export class AssetToken {
  readonly address: Address;
  readonly decimals: number;
  readonly amount: number;
  readonly rawAmount: bigint;

  constructor(address: Address, decimals: number, amount: number) {
    this.address = address;
    this.decimals = decimals;
    this.amount = amount;
    this.rawAmount = parseUnits(amount.toString(), decimals);
  }

  static create(
    address: Address,
    decimals: number,
    amount: number
  ): AssetToken {
    return new AssetToken(address, decimals, amount);
  }

  static usdc(amount: number, chainId: number): AssetToken {
    const address = getAddressForChain(USDC_ADDRESSES, chainId, "USDC");
    return new AssetToken(address, USDC_DECIMALS, amount);
  }

  static usdcFromRaw(rawAmount: bigint, chainId: number): AssetToken {
    const address = getAddressForChain(USDC_ADDRESSES, chainId, "USDC");
    const dec = Number(rawAmount) / 10 ** USDC_DECIMALS;
    return new AssetToken(address, USDC_DECIMALS, dec);
  }

  static async fromOnChain(
    address: Address,
    amount: number,
    chainId: number,
    client: AcpClient
  ): Promise<AssetToken> {
    const decimals = await client.getTokenDecimals(chainId, address);
    return new AssetToken(address, decimals, amount);
  }
}
