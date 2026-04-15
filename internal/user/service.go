package user

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	userv1 "github.com/example/todo-service/gen/user/v1"
)

type Service struct {
	userv1.UnimplementedUserServiceServer
	db         *DBClient
	todoClient *TodoClient
}

func NewService(db *DBClient, todoClient *TodoClient) *Service {
	return &Service{db: db, todoClient: todoClient}
}

func (s *Service) CreateUser(ctx context.Context, req *userv1.CreateUserRequest) (*userv1.CreateUserResponse, error) {
	if req.Name == "" {
		return nil, status.Error(codes.InvalidArgument, "name is required")
	}
	if req.Email == "" {
		return nil, status.Error(codes.InvalidArgument, "email is required")
	}

	doc, err := s.db.Create(ctx, &UserDoc{
		Name:  req.Name,
		Email: req.Email,
	})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to create user: %v", err)
	}

	return &userv1.CreateUserResponse{User: docToProto(doc)}, nil
}

func (s *Service) GetUser(ctx context.Context, req *userv1.GetUserRequest) (*userv1.GetUserResponse, error) {
	if req.Id == "" {
		return nil, status.Error(codes.InvalidArgument, "id is required")
	}

	doc, err := s.db.GetByID(ctx, req.Id)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "user not found: %v", err)
	}

	return &userv1.GetUserResponse{User: docToProto(doc)}, nil
}

func (s *Service) GetUserTodos(ctx context.Context, req *userv1.GetUserTodosRequest) (*userv1.GetUserTodosResponse, error) {
	if req.UserId == "" {
		return nil, status.Error(codes.InvalidArgument, "user_id is required")
	}

	// Verify user exists
	_, err := s.db.GetByID(ctx, req.UserId)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "user not found: %v", err)
	}

	// Call todo-service via gRPC
	resp, err := s.todoClient.ListTodos(ctx, req.PageSize, req.PageToken)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to list todos: %v", err)
	}

	return &userv1.GetUserTodosResponse{
		Todos:         resp.Todos,
		NextPageToken: resp.NextPageToken,
	}, nil
}

func docToProto(doc *UserDoc) *userv1.User {
	return &userv1.User{
		Id:        doc.ID.Hex(),
		Name:      doc.Name,
		Email:     doc.Email,
		CreatedAt: timestamppb.New(doc.CreatedAt),
		UpdatedAt: timestamppb.New(doc.UpdatedAt),
	}
}
