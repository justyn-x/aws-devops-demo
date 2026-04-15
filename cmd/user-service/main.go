package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/reflection"

	userv1 "github.com/example/todo-service/gen/user/v1"
	shareddb "github.com/example/todo-service/internal/shared/db"
	"github.com/example/todo-service/internal/user"
)

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	conn, err := shareddb.Connect(ctx)
	if err != nil {
		log.Fatalf("failed to connect to DocumentDB: %v", err)
	}
	defer conn.Close(ctx)

	todoAddr := envOrDefault("TODO_SERVICE_GRPC_ADDR", "todo-service-grpc:50051")
	todoClient, err := user.NewTodoClient(todoAddr)
	if err != nil {
		log.Fatalf("failed to connect to todo-service: %v", err)
	}
	defer todoClient.Close()

	dbClient := user.NewDBClient(conn)

	grpcPort := envOrDefault("GRPC_PORT", "50051")
	httpPort := envOrDefault("HTTP_PORT", "8080")

	grpcServer := grpc.NewServer()
	userSvc := user.NewService(dbClient, todoClient)
	userv1.RegisterUserServiceServer(grpcServer, userSvc)
	reflection.Register(grpcServer)

	lis, err := net.Listen("tcp", fmt.Sprintf(":%s", grpcPort))
	if err != nil {
		log.Fatalf("failed to listen on port %s: %v", grpcPort, err)
	}

	go func() {
		log.Printf("gRPC server listening on :%s", grpcPort)
		if err := grpcServer.Serve(lis); err != nil {
			log.Fatalf("failed to serve gRPC: %v", err)
		}
	}()

	mux := runtime.NewServeMux()
	opts := []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}
	err = userv1.RegisterUserServiceHandlerFromEndpoint(ctx, mux, fmt.Sprintf("localhost:%s", grpcPort), opts)
	if err != nil {
		log.Fatalf("failed to register gateway: %v", err)
	}

	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	httpMux.Handle("/", mux)

	httpServer := &http.Server{
		Addr:    fmt.Sprintf(":%s", httpPort),
		Handler: httpMux,
	}

	go func() {
		log.Printf("HTTP gateway listening on :%s", httpPort)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("failed to serve HTTP: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("shutting down...")
	grpcServer.GracefulStop()
	httpServer.Shutdown(ctx)
}

func envOrDefault(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}
