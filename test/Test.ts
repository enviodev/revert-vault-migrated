import assert from "assert";
import { 
  TestHelpers,
  V3Vault_Add
} from "generated";
const { MockDb, V3Vault } = TestHelpers;

describe("V3Vault contract Add event tests", () => {
  // Create mock db
  const mockDb = MockDb.createMockDb();

  // Creating mock for V3Vault contract Add event
  const event = V3Vault.Add.createMockEvent({/* It mocks event fields with default values. You can overwrite them if you need */});

  it("V3Vault_Add is created correctly", async () => {
    // Processing the event
    const mockDbUpdated = await V3Vault.Add.processEvent({
      event,
      mockDb,
    });

    // Getting the actual entity from the mock database
    let actualV3VaultAdd = mockDbUpdated.entities.V3Vault_Add.get(
      `${event.chainId}_${event.block.number}_${event.logIndex}`
    );

    // Creating the expected entity
    const expectedV3VaultAdd: V3Vault_Add = {
      id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
      tokenId: event.params.tokenId,
      owner: event.params.owner,
      oldTokenId: event.params.oldTokenId,
    };
    // Asserting that the entity in the mock database is the same as the expected entity
    assert.deepEqual(actualV3VaultAdd, expectedV3VaultAdd, "Actual V3VaultAdd should be the same as the expectedV3VaultAdd");
  });
});
