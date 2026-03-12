import { parseUnits } from "viem";
import type { AcpClient } from "../clientFactory";
import { USDC_ADDRESS, USDC_DECIMALS } from "./constants";

export class Erc20Token {
  readonly address: string;
  readonly decimals: number;
  readonly amount: number;
  readonly rawAmount: bigint;

  constructor(address: string, decimals: number, amount: number) {
    this.address = address;
    this.decimals = decimals;
    this.amount = amount;
    this.rawAmount = parseUnits(amount.toString(), decimals);
  }

  static create(address: string, decimals: number, amount: number): Erc20Token {
    return new Erc20Token(address, decimals, amount);
  }

  static usdc(amount: number, address?: string): Erc20Token {
    return new Erc20Token(address ?? USDC_ADDRESS, USDC_DECIMALS, amount);
  }

  static usdcFromRaw(rawAmount: bigint, address?: string): Erc20Token {
    const dec = Number(rawAmount) / 10 ** USDC_DECIMALS;
    return new Erc20Token(address ?? USDC_ADDRESS, USDC_DECIMALS, dec);
  }

  static async fromOnChain(
    address: string,
    amount: number,
    client: AcpClient
  ): Promise<Erc20Token> {
    const decimals = await client.getTokenDecimals(address);
    return new Erc20Token(address, decimals, amount);
  }
}
