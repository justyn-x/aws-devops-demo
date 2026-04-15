package todo

import (
	"context"

	"go.mongodb.org/mongo-driver/bson"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	todov1 "github.com/example/todo-service/gen/todo/v1"
)

type Service struct {
	todov1.UnimplementedTodoServiceServer
	db *DBClient
}

func NewService(dbClient *DBClient) *Service {
	return &Service{db: dbClient}
}

func (s *Service) CreateTodo(ctx context.Context, req *todov1.CreateTodoRequest) (*todov1.CreateTodoResponse, error) {
	if req.Title == "" {
		return nil, status.Error(codes.InvalidArgument, "title is required")
	}

	doc, err := s.db.Create(ctx, &TodoDoc{
		Title:       req.Title,
		Description: req.Description,
	})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to create todo: %v", err)
	}

	return &todov1.CreateTodoResponse{Todo: docToProto(doc)}, nil
}

func (s *Service) GetTodo(ctx context.Context, req *todov1.GetTodoRequest) (*todov1.GetTodoResponse, error) {
	if req.Id == "" {
		return nil, status.Error(codes.InvalidArgument, "id is required")
	}

	doc, err := s.db.GetByID(ctx, req.Id)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "todo not found: %v", err)
	}

	return &todov1.GetTodoResponse{Todo: docToProto(doc)}, nil
}

func (s *Service) ListTodos(ctx context.Context, req *todov1.ListTodosRequest) (*todov1.ListTodosResponse, error) {
	docs, nextToken, err := s.db.List(ctx, req.PageSize, req.PageToken)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to list todos: %v", err)
	}

	todos := make([]*todov1.Todo, len(docs))
	for i, doc := range docs {
		todos[i] = docToProto(doc)
	}

	return &todov1.ListTodosResponse{
		Todos:         todos,
		NextPageToken: nextToken,
	}, nil
}

func (s *Service) UpdateTodo(ctx context.Context, req *todov1.UpdateTodoRequest) (*todov1.UpdateTodoResponse, error) {
	if req.Todo == nil || req.Todo.Id == "" {
		return nil, status.Error(codes.InvalidArgument, "todo with id is required")
	}

	updates := bson.M{}
	if req.UpdateMask == nil || len(req.UpdateMask.Paths) == 0 {
		// 没有 field mask 时更新所有可变字段
		updates["title"] = req.Todo.Title
		updates["description"] = req.Todo.Description
		updates["completed"] = req.Todo.Completed
	} else {
		for _, path := range req.UpdateMask.Paths {
			switch path {
			case "title":
				updates["title"] = req.Todo.Title
			case "description":
				updates["description"] = req.Todo.Description
			case "completed":
				updates["completed"] = req.Todo.Completed
			}
		}
	}

	doc, err := s.db.Update(ctx, req.Todo.Id, updates)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to update todo: %v", err)
	}

	return &todov1.UpdateTodoResponse{Todo: docToProto(doc)}, nil
}

func (s *Service) DeleteTodo(ctx context.Context, req *todov1.DeleteTodoRequest) (*emptypb.Empty, error) {
	if req.Id == "" {
		return nil, status.Error(codes.InvalidArgument, "id is required")
	}

	if err := s.db.Delete(ctx, req.Id); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to delete todo: %v", err)
	}

	return &emptypb.Empty{}, nil
}

func docToProto(doc *TodoDoc) *todov1.Todo {
	return &todov1.Todo{
		Id:          doc.ID.Hex(),
		Title:       doc.Title,
		Description: doc.Description,
		Completed:   doc.Completed,
		CreatedAt:   timestamppb.New(doc.CreatedAt),
		UpdatedAt:   timestamppb.New(doc.UpdatedAt),
	}
}
