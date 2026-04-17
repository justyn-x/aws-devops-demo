package db

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/url"
	"os"

	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.opentelemetry.io/contrib/instrumentation/go.mongodb.org/mongo-driver/mongo/otelmongo"
)

// Conn holds a MongoDB client and provides access to databases.
type Conn struct {
	Client *mongo.Client
}

// Connect creates a new MongoDB/DocumentDB connection from environment variables.
// Supports either a full DOCUMENTDB_URI or individual DOCUMENTDB_HOST/USERNAME/PASSWORD.
func Connect(ctx context.Context) (*Conn, error) {
	uri := os.Getenv("DOCUMENTDB_URI")
	if uri == "" {
		host := os.Getenv("DOCUMENTDB_HOST")
		user := os.Getenv("DOCUMENTDB_USERNAME")
		pass := os.Getenv("DOCUMENTDB_PASSWORD")
		if host != "" && user != "" && pass != "" {
			uri = fmt.Sprintf("mongodb://%s:%s@%s:27017/?tls=true&retryWrites=false&readPreference=secondaryPreferred", url.QueryEscape(user), url.QueryEscape(pass), host)
		} else {
			uri = "mongodb://localhost:27017"
		}
	}

	opts := options.Client().ApplyURI(uri)

	caFile := os.Getenv("DOCUMENTDB_CA_FILE")
	if caFile != "" {
		tlsConfig, err := buildTLSConfig(caFile)
		if err != nil {
			return nil, fmt.Errorf("failed to build TLS config: %w", err)
		}
		opts.SetTLSConfig(tlsConfig)
	}

	opts.SetMonitor(otelmongo.NewMonitor())
	opts.SetRetryWrites(false) // Required for DocumentDB

	client, err := mongo.Connect(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to DocumentDB: %w", err)
	}

	if err := client.Ping(ctx, nil); err != nil {
		return nil, fmt.Errorf("failed to ping DocumentDB: %w", err)
	}

	return &Conn{Client: client}, nil
}

func (c *Conn) Close(ctx context.Context) error {
	return c.Client.Disconnect(ctx)
}

// Collection returns a handle to a specific database + collection.
func (c *Conn) Collection(database, collection string) *mongo.Collection {
	return c.Client.Database(database).Collection(collection)
}

func buildTLSConfig(caFile string) (*tls.Config, error) {
	caCert, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("failed to read CA file: %w", err)
	}
	caCertPool := x509.NewCertPool()
	if !caCertPool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("failed to parse CA certificate")
	}
	return &tls.Config{
		RootCAs: caCertPool,
	}, nil
}
