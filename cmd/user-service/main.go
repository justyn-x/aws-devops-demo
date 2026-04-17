package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/reflection"

	userv1 "github.com/example/todo-service/gen/user/v1"
	shareddb "github.com/example/todo-service/internal/shared/db"
	"github.com/example/todo-service/internal/shared/logger"
	appotel "github.com/example/todo-service/internal/shared/otel"
	"github.com/example/todo-service/internal/user"
)

func main() {
	logger.Init()
	defer zap.L().Sync()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	otelShutdown, err := appotel.Init(ctx, "user-service", "0.1.0", envOrDefault("DEPLOYMENT_ENV", "dev"))
	if err != nil {
		zap.L().Fatal("failed to init otel", zap.Error(err))
	}
	defer otelShutdown(ctx)

	zap.L().Info("user-service starting...")

	conn, err := shareddb.Connect(ctx)
	if err != nil {
		zap.L().Fatal("failed to connect to DocumentDB", zap.Error(err))
	}
	defer conn.Close(ctx)

	todoAddr := envOrDefault("TODO_SERVICE_GRPC_ADDR", "todo-service-grpc:50051")
	todoClient, err := user.NewTodoClient(todoAddr)
	if err != nil {
		zap.L().Fatal("failed to connect to todo-service", zap.Error(err))
	}
	defer todoClient.Close()

	dbClient := user.NewDBClient(conn)

	grpcPort := envOrDefault("GRPC_PORT", "50051")
	httpPort := envOrDefault("HTTP_PORT", "8080")

	grpcServer := grpc.NewServer(
		grpc.StatsHandler(otelgrpc.NewServerHandler()),
		grpc.ChainUnaryInterceptor(
			logger.UnaryServerInterceptor(),
		),
	)
	userSvc := user.NewService(dbClient, todoClient)
	userv1.RegisterUserServiceServer(grpcServer, userSvc)
	reflection.Register(grpcServer)

	lis, err := net.Listen("tcp", fmt.Sprintf(":%s", grpcPort))
	if err != nil {
		zap.L().Fatal("failed to listen on gRPC port", zap.String("port", grpcPort), zap.Error(err))
	}

	go func() {
		zap.L().Info("gRPC server listening", zap.String("port", grpcPort))
		if err := grpcServer.Serve(lis); err != nil {
			zap.L().Fatal("failed to serve gRPC", zap.Error(err))
		}
	}()

	mux := runtime.NewServeMux()
	opts := []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}
	err = userv1.RegisterUserServiceHandlerFromEndpoint(ctx, mux, fmt.Sprintf("localhost:%s", grpcPort), opts)
	if err != nil {
		zap.L().Fatal("failed to register gateway", zap.Error(err))
	}

	httpMux := http.NewServeMux()
	httpMux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	httpMux.Handle("/", mux)

	handler := logger.Middleware(otelhttp.NewHandler(httpMux, "user-service-http"))

	httpServer := &http.Server{
		Addr:    fmt.Sprintf(":%s", httpPort),
		Handler: handler,
	}

	go func() {
		zap.L().Info("HTTP gateway listening", zap.String("port", httpPort))
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			zap.L().Fatal("failed to serve HTTP", zap.Error(err))
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	zap.L().Info("shutting down...")
	grpcServer.GracefulStop()
	httpServer.Shutdown(ctx)
}

func envOrDefault(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}
