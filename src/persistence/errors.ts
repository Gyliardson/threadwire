export class ThreadStoreInvalidError extends Error {
  public constructor(message: string = "Threadwire persistent thread state is invalid or incompatible.") {
    super(message);
    this.name = "ThreadStoreInvalidError";
  }
}

export class ThreadStoreUnavailableError extends Error {
  public constructor(message: string = "Threadwire persistent thread state is unavailable.") {
    super(message);
    this.name = "ThreadStoreUnavailableError";
  }
}
