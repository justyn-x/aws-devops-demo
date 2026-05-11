package logger

import (
	"net/http"
	"time"

	"go.uber.org/zap"
)

type responseWriter struct {
	http.ResponseWriter
	status         int
	headerWritten  bool
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.status = code
	rw.headerWritten = true
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	rw.headerWritten = true
	return rw.ResponseWriter.Write(b)
}

// Middleware logs every HTTP request with method, path, status, and duration.
// It also stamps each response with the X-Service-Revision header so callers can tell
// which task (blue/green) handled the request during a LINEAR deployment.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Stamp revision header before any handler can write status.
		w.Header().Set("X-Service-Revision", revision)

		// Skip health checks to reduce log noise.
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}

		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rw, r)
		duration := time.Since(start)

		l := FromContext(r.Context())
		l.Info("http.request",
			zap.String("method", r.Method),
			zap.String("path", r.URL.Path),
			zap.Int("status", rw.status),
			zap.Float64("duration_ms", float64(duration.Milliseconds())),
			zap.String("remote_addr", r.RemoteAddr),
		)
	})
}
