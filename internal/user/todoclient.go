package user

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	todov1 "github.com/example/todo-service/gen/todo/v1"
	"github.com/example/todo-service/internal/shared/logger"
)

type TodoClient struct {
	conn   *grpc.ClientConn
	client todov1.TodoServiceClient
}

// NewTodoClient connects to the todo-service gRPC endpoint.
// addr should be "todo-service-grpc:50051" in ECS (via Service Connect)
// or "todo-service:50051" in docker-compose.
func NewTodoClient(addr string) (*TodoClient, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, err := grpc.DialContext(ctx, addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
		grpc.WithChainUnaryInterceptor(
			logger.UnaryClientInterceptor(),
		),
		grpc.WithDefaultServiceConfig(`{
			"methodConfig": [{
				"name": [{}],
				"retryPolicy": {
					"maxAttempts": 3,
					"initialBackoff": "0.1s",
					"maxBackoff": "1s",
					"backoffMultiplier": 2,
					"retryableStatusCodes": ["UNAVAILABLE"]
				}
			}]
		}`),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to todo-service: %w", err)
	}

	return &TodoClient{
		conn:   conn,
		client: todov1.NewTodoServiceClient(conn),
	}, nil
}

func (tc *TodoClient) Close() error {
	return tc.conn.Close()
}

func (tc *TodoClient) ListTodos(ctx context.Context, pageSize int32, pageToken string) (*todov1.ListTodosResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	return tc.client.ListTodos(ctx, &todov1.ListTodosRequest{
		PageSize:  pageSize,
		PageToken: pageToken,
	})
}
