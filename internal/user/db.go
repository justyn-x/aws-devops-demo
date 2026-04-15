package user

import (
	"context"
	"fmt"
	"os"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"

	shareddb "github.com/example/todo-service/internal/shared/db"
)

type UserDoc struct {
	ID        primitive.ObjectID `bson:"_id,omitempty"`
	Name      string             `bson:"name"`
	Email     string             `bson:"email"`
	CreatedAt time.Time          `bson:"created_at"`
	UpdatedAt time.Time          `bson:"updated_at"`
}

type DBClient struct {
	collection *mongo.Collection
}

func NewDBClient(conn *shareddb.Conn) *DBClient {
	dbName := os.Getenv("DOCUMENTDB_DATABASE")
	if dbName == "" {
		dbName = "user_db"
	}
	return &DBClient{
		collection: conn.Collection(dbName, "users"),
	}
}

func (c *DBClient) Create(ctx context.Context, doc *UserDoc) (*UserDoc, error) {
	now := time.Now()
	doc.CreatedAt = now
	doc.UpdatedAt = now
	result, err := c.collection.InsertOne(ctx, doc)
	if err != nil {
		return nil, fmt.Errorf("failed to insert user: %w", err)
	}
	doc.ID = result.InsertedID.(primitive.ObjectID)
	return doc, nil
}

func (c *DBClient) GetByID(ctx context.Context, id string) (*UserDoc, error) {
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		return nil, fmt.Errorf("invalid id: %w", err)
	}
	var doc UserDoc
	err = c.collection.FindOne(ctx, bson.M{"_id": objID}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("user not found")
		}
		return nil, fmt.Errorf("failed to get user: %w", err)
	}
	return &doc, nil
}
