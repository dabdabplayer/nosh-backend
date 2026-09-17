import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

// Shared single-item read/write primitives for the one DynamoDB table
// backing every Nosh store (SwiggyTokenStore + the Pending* classes). Each
// store owns its own key prefix (see pk() in each file) but all of them
// read/write a single `value` attribute under a single `pk` partition key -
// there's no per-store table to manage.

export async function getValue(documentClient, tableName, pk) {
  const { Item } = await documentClient.send(new GetCommand({ TableName: tableName, Key: { pk } }));
  return Item?.value;
}

export async function putValue(documentClient, tableName, pk, value) {
  await documentClient.send(new PutCommand({ TableName: tableName, Item: { pk, value } }));
}

export async function deleteValue(documentClient, tableName, pk) {
  await documentClient.send(new DeleteCommand({ TableName: tableName, Key: { pk } }));
}

// Atomic get-and-delete in a single round trip - preserves take()'s current
// in-memory semantics exactly, including that a second take() on the same
// key returns undefined.
export async function takeValue(documentClient, tableName, pk) {
  const { Attributes } = await documentClient.send(
    new DeleteCommand({ TableName: tableName, Key: { pk }, ReturnValues: "ALL_OLD" }),
  );
  return Attributes?.value;
}

// Atomically claims a key exactly once - used by message-idempotency, where
// two concurrent Fargate tasks must not both conclude the same message is
// unprocessed. Returns true if this call claimed the key (it wasn't already
// present), false if it was already claimed.
export async function claimOnce(documentClient, tableName, pk) {
  try {
    await documentClient.send(
      new PutCommand({
        TableName: tableName,
        Item: { pk },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return true;
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw error;
  }
}
