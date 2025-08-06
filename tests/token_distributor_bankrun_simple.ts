import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenDistributor } from "../target/types/token_distributor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { expect } from "chai";
import { startAnchor, Clock, ProgramTestContext } from "solana-bankrun";

describe("bankrun time control demonstration", () => {
  let context: ProgramTestContext;

  before(async () => {
    // Start bankrun context
    context = await startAnchor("./", [], []);
    console.log("Bankrun context started successfully");
  });

  it("Basic clock control demonstration", async () => {
    try {
      console.log("=== Basic Clock Control Demonstration ===");
      
      // Get initial clock
      const initialClock = await context.banksClient.getClock();
      console.log("Initial time:", Number(initialClock.unixTimestamp));
      
      // Advance time by 100 seconds
      const newClock = new Clock(
        initialClock.slot,
        initialClock.epochStartTimestamp,
        initialClock.epoch,
        initialClock.leaderScheduleEpoch,
        BigInt(Number(initialClock.unixTimestamp) + 100)
      );
      
      await context.setClock(newClock);
      
      // Verify time was advanced
      const updatedClock = await context.banksClient.getClock();
      console.log("Updated time:", Number(updatedClock.unixTimestamp));
      console.log("Time difference:", Number(updatedClock.unixTimestamp) - Number(initialClock.unixTimestamp), "seconds");
      
      expect(Number(updatedClock.unixTimestamp)).to.equal(Number(initialClock.unixTimestamp) + 100);
      
      console.log("✅ Basic clock control test passed!");
      
    } catch (error) {
      console.error("Basic clock control test failed:", error);
      throw error;
    }
  });

  it("Demonstrate setTimeout replacement", async () => {
    try {
      console.log("=== Demonstrating setTimeout Replacement ===");
      
      // Get current clock
      const currentClock = await context.banksClient.getClock();
      console.log("Current time:", Number(currentClock.unixTimestamp));
      
      // OLD WAY (commented out to avoid actual waiting):
      // console.log("🕐 Old way: await new Promise(resolve => setTimeout(resolve, 12000));");
      // await new Promise(resolve => setTimeout(resolve, 12000)); // Wait 12 seconds
      
      // NEW WAY: Advance time instantly
      console.log("🕐 Old way would be: await new Promise(resolve => setTimeout(resolve, 12000));");
      console.log("⚡ New way: Using bankrun to advance time instantly!");
      
      const startTime = Date.now();
      
      // Advance clock by 12 seconds
      const newClock = new Clock(
        currentClock.slot,
        currentClock.epochStartTimestamp,
        currentClock.epoch,
        currentClock.leaderScheduleEpoch,
        BigInt(Number(currentClock.unixTimestamp) + 12)
      );
      
      await context.setClock(newClock);
      
      const endTime = Date.now();
      const actualTimeSpent = endTime - startTime;
      
      // Verify time was advanced
      const updatedClock = await context.banksClient.getClock();
      const blockchainTimeAdvanced = Number(updatedClock.unixTimestamp) - Number(currentClock.unixTimestamp);
      
      console.log(`✅ Blockchain time advanced: ${blockchainTimeAdvanced} seconds`);
      console.log(`✅ Real time spent: ${actualTimeSpent}ms (instead of 12000ms)`);
      console.log(`🚀 Speed improvement: ${Math.round(12000 / actualTimeSpent)}x faster!`);
      
      expect(blockchainTimeAdvanced).to.equal(12);
      expect(actualTimeSpent).to.be.lessThan(1000); // Should be much less than 1 second
      
      console.log("✅ setTimeout replacement demonstration completed!");
      
    } catch (error) {
      console.error("setTimeout replacement test failed:", error);
      throw error;
    }
  });
}); 