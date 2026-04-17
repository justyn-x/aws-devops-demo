package logger

import (
	"context"
	"os"
	"strings"

	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// Init initializes the global zap logger with JSON encoding for CloudWatch Logs.
// Level is controlled by the LOG_LEVEL env var (default: "info").
func Init() {
	level := parseLevel(os.Getenv("LOG_LEVEL"))

	cfg := zap.Config{
		Level:       zap.NewAtomicLevelAt(level),
		Encoding:    "json",
		OutputPaths: []string{"stdout"},
		EncoderConfig: zapcore.EncoderConfig{
			TimeKey:        "ts",
			LevelKey:       "level",
			NameKey:        "logger",
			CallerKey:      "caller",
			MessageKey:     "msg",
			StacktraceKey:  "stacktrace",
			LineEnding:     zapcore.DefaultLineEnding,
			EncodeLevel:    zapcore.LowercaseLevelEncoder,
			EncodeTime:     zapcore.ISO8601TimeEncoder,
			EncodeDuration: zapcore.MillisDurationEncoder,
			EncodeCaller:   zapcore.ShortCallerEncoder,
		},
	}

	l, err := cfg.Build(zap.AddCallerSkip(0))
	if err != nil {
		panic("failed to init logger: " + err.Error())
	}
	zap.ReplaceGlobals(l)
}

// FromContext returns a logger enriched with the trace_id from the OTEL span in ctx.
func FromContext(ctx context.Context) *zap.Logger {
	l := zap.L()
	sc := trace.SpanContextFromContext(ctx)
	if sc.HasTraceID() {
		l = l.With(zap.String("trace_id", sc.TraceID().String()))
	}
	return l
}

func parseLevel(s string) zapcore.Level {
	switch strings.ToLower(s) {
	case "debug":
		return zapcore.DebugLevel
	case "warn", "warning":
		return zapcore.WarnLevel
	case "error":
		return zapcore.ErrorLevel
	default:
		return zapcore.InfoLevel
	}
}
