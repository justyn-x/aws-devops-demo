.PHONY: generate build-todo build-user build-all run-todo run-user clean tidy

generate:
	buf generate

build-todo: generate
	go build -o bin/todo-service ./cmd/todo-service

build-user: generate
	go build -o bin/user-service ./cmd/user-service

build-all: build-todo build-user

run-todo: build-todo
	./bin/todo-service

run-user: build-user
	./bin/user-service

clean:
	rm -rf bin/ gen/

tidy:
	go mod tidy
