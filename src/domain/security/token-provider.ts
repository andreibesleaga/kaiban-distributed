export interface ITokenProvider {
  getToken(service: string, taskId: string): Promise<string | undefined>;
}
