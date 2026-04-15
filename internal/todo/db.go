package todo

import (
	"context"
	"fmt"
	"os"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

	shareddb "github.com/example/todo-service/internal/shared/db"
)

type TodoDoc struct {
	ID          primitive.ObjectID `bson:"_id,omitempty"`
	Title       string             `bson:"title"`
	Description string             `bson:"description"`
	Completed   bool               `bson:"completed"`
	CreatedAt   time.Time          `bson:"created_at"`
	UpdatedAt   time.Time          `bson:"updated_at"`
}

type DBClient struct {
	conn       *shareddb.Conn
	collection *mongo.Collection
}

func NewDBClient(conn *shareddb.Conn) *DBClient {
	dbName := os.Getenv("DOCUMENTDB_DATABASE")
	if dbName == "" {
		dbName = "todo_db"
	}
	return &DBClient{
		conn:       conn,
		collection: conn.Collection(dbName, "todos"),
	}
}

func (c *DBClient) Create(ctx context.Context, doc *TodoDoc) (*TodoDoc, error) {
	now := time.Now()
	doc.CreatedAt = now
	doc.UpdatedAt = now
	result, err := c.collection.InsertOne(ctx, doc)
	if err != nil {
		return nil, fmt.Errorf("failed to insert todo: %w", err)
	}
	doc.ID = result.InsertedID.(primitive.ObjectID)
	return doc, nil
}

func (c *DBClient) GetByID(ctx context.Context, id string) (*TodoDoc, error) {
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid id: %w", err)
	}
	var doc TodoDoc
	err = c.collection.FindOne(ctx, bson.M{"_id": objID}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("todo not found")
		}
		return nil, fmt.Errorf("failed to get todo: %w", err)
	}
	return &doc, nil
}

func (c *DBClient) List(ctx context.Context, pageSize int32, pageToken string) ([]*TodoDoc, string, error) {
	if pageSize <= 0 {
		pageSize = 20
	}
	filter := bson.M{}
	if pageToken != "" {
		objID, err := primitive.ObjectIDFromHex(pageToken)
		if err != nil {
			return nil, "", fmt.Errorf("invalid page token: %w", err)
		}
		filter["_id"] = bson.M{"$gt": objID}
	}
	opts := options.Find().
		SetSort(bson.D{{Key: "_id", Value: 1}}).
		SetLimit(int64(pageSize + 1))
	cursor, err := c.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, "", fmt.Errorf("failed to list todos: %w", err)
	}
	defer cursor.Close(ctx)
	var docs []*TodoDoc
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, "", fmt.Errorf("failed to decode todos: %w", err)
	}
	var nextToken string
	if int32(len(docs)) > pageSize {
		nextToken = docs[pageSize-1].ID.Hex()
		docs = docs[:pageSize]
	}
	return docs, nextToken, nil
}

func (c *DBClient) Update(ctx context.Context, id string, updates bson.M) (*TodoDoc, error) {
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid id: %w", err)
	}
	updates["updated_at"] = time.Now()
	result := c.collection.FindOneAndUpdate(
		ctx,
		bson.M{"_id": objID},
		bson.M{"$set": updates},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	)
	var doc TodoDoc
	if err := result.Decode(&doc); err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("todo not found")
		}
		return nil, fmt.Errorf("failed to update todo: %w", err)
	}
	return &doc, nil
}

func (c *DBClient) Delete(ctx context.Context, id string) error {
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		return fmt.Errorf("invalid id: %w", err)
	}
	result, err := c.collection.DeleteOne(ctx, bson.M{"_id": objID})
	if err != nil {
		return fmt.Errorf("failed to delete todo: %w", err)
	}
	if result.DeletedCount == 0 {
		return fmt.Errorf("todo not found")
	}
	return nil
}
