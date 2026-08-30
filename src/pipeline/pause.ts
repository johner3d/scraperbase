export class PipelinePausedError extends Error {
  source:string;
  resumeAfter:string|null;
  constructor(source:string,resumeAfter:string|null,message:string){super(message);this.name='PipelinePausedError';this.source=source;this.resumeAfter=resumeAfter;}
}
