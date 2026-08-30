export class PipelinePausedError extends Error {
  source:string;
  resumeAfter:string|null;
  constructor(source:string,resumeAfter:string|null,message:string){super(message);this.name='PipelinePausedError';this.source=source;this.resumeAfter=resumeAfter;}
}

// The persistent PSA browser profile is no longer signed in. Defined next to
// the browser engine (which has to detect it) and re-exported here because the
// pipeline stages catch it and turn it into a pause resolved by `pipeline
// psa-login`. Kept out of a direct sources -> pipeline import.
export { PsaSessionExpiredError } from '../sources/psa/rawFetch.ts';
