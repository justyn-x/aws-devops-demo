package logger

import (
	"context"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// UnaryServerInterceptor returns a gRPC server interceptor that logs every unary RPC
// and stamps each response with the x-service-revision header so callers can tell
// which task (blue/green) handled the request during a LINEAR deployment.
func UnaryServerInterceptor() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		// Stamp revision header before invoking the handler so it lands on the response
		// regardless of whether the handler errors out.
		_ = grpc.SetHeader(ctx, metadata.Pairs("x-service-revision", revision))

		start := time.Now()
		resp, err := handler(ctx, req)
		duration := time.Since(start)

		code := status.Code(err)
		fields := []zap.Field{
			zap.String("grpc.method", info.FullMethod),
			zap.Float64("duration_ms", float64(duration.Milliseconds())),
			zap.String("grpc.code", code.String()),
		}

		l := FromContext(ctx)
		switch {
		case err == nil:
			l.Info("grpc.server.unary", fields...)
		case code == codes.InvalidArgument || code == codes.NotFound || code == codes.AlreadyExists:
			l.Warn("grpc.server.unary", append(fields, zap.Error(err))...)
		default:
			l.Error("grpc.server.unary", append(fields, zap.Error(err))...)
		}

		return resp, err
	}
}

// UnaryClientInterceptor returns a gRPC client interceptor that logs every outbound unary RPC.
func UnaryClientInterceptor() grpc.UnaryClientInterceptor {
	return func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		start := time.Now()
		err := invoker(ctx, method, req, reply, cc, opts...)
		duration := time.Since(start)

		code := status.Code(err)
		fields := []zap.Field{
			zap.String("grpc.method", method),
			zap.Float64("duration_ms", float64(duration.Milliseconds())),
			zap.String("grpc.code", code.String()),
		}

		l := FromContext(ctx)
		if err != nil {
			l.Error("grpc.client.unary", append(fields, zap.Error(err))...)
		} else {
			l.Info("grpc.client.unary", fields...)
		}

		return err
	}
}
