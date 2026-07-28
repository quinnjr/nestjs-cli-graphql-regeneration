export interface EmitRequest {
  projectRoot: string;
  distRoot: string;
  appModulePath: string;
  schemaName: string;
}

export interface EmitSuccess {
  ok: true;
  sdl: string;
  outFile: string;
}

export interface EmitFailure {
  ok: false;
  message: string;
  stack?: string;
}
