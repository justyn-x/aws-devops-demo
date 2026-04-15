const HTTP_PORT = 8080;
const GRPC_PORT = 50051;

export interface ServiceConfig {
  readonly serviceName: string;
  readonly httpPort: number;
  readonly grpcPort: number;
  readonly routeKeys: string[];
  readonly databaseName: string;
  readonly envVars?: Record<string, string>;
}

export const serviceConfigs: Record<string, ServiceConfig> = {
  'todo-service': {
    serviceName: 'todo-service',
    httpPort: HTTP_PORT,
    grpcPort: GRPC_PORT,
    routeKeys: ['ANY /v1/todos', 'ANY /v1/todos/{proxy+}'],
    databaseName: 'todo_db',
  },
  'user-service': {
    serviceName: 'user-service',
    httpPort: HTTP_PORT,
    grpcPort: GRPC_PORT,
    routeKeys: ['ANY /v1/users', 'ANY /v1/users/{proxy+}'],
    databaseName: 'user_db',
  },
};
