import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    amoy: {
      url: process.env.AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts,
      // Amoy's base fee is ~0 but RPC fee suggestions spike wildly (200+
      // gwei tips) while blocks land fine at the ~25-30 gwei validator
      // minimum. An explicit cap keeps faucet-funded deploys affordable;
      // unset it to fall back to the RPC's suggestion.
      ...(process.env.AMOY_GAS_PRICE_GWEI
        ? { gasPrice: Number(process.env.AMOY_GAS_PRICE_GWEI) * 1e9 }
        : {}),
    },
  },
  etherscan: {
    apiKey: { polygonAmoy: process.env.POLYGONSCAN_API_KEY ?? "" },
  },
};

export default config;
