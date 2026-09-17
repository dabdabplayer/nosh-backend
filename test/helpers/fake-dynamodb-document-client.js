import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

// A minimal in-memory stand-in for a DynamoDBDocumentClient, scoped to
// exactly the Get/Put/Delete usage in src/dynamo-item-store.js. Lets every
// store class's tests run without a real AWS account or DynamoDB Local.
export function createFakeDynamoDocumentClient() {
  const itemsByKey = new Map();

  return {
    // Test-only introspection (not part of the real DynamoDBDocumentClient
    // shape) - lets a test assert on the raw stored items, e.g. to confirm
    // nothing sensitive was ever written in plaintext.
    __itemsForTest() {
      return itemsByKey.values();
    },

    async send(command) {
      if (command instanceof GetCommand) {
        return { Item: itemsByKey.get(command.input.Key.pk) };
      }

      if (command instanceof PutCommand) {
        const { Item, ConditionExpression } = command.input;
        const key = Item.pk;

        if (ConditionExpression === "attribute_not_exists(pk)" && itemsByKey.has(key)) {
          const error = new Error("The conditional request failed");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }

        itemsByKey.set(key, Item);
        return {};
      }

      if (command instanceof DeleteCommand) {
        const key = command.input.Key.pk;
        const previous = itemsByKey.get(key);
        itemsByKey.delete(key);

        return command.input.ReturnValues === "ALL_OLD" ? { Attributes: previous } : {};
      }

      throw new Error(`Unsupported command in fake DynamoDB document client: ${command.constructor.name}`);
    },
  };
}

// Shared constructor args for every store class's tests - a fresh fake
// client (isolated per store instance) plus a fixed table name.
export function testStoreDeps() {
  return { documentClient: createFakeDynamoDocumentClient(), tableName: "test-table" };
}
