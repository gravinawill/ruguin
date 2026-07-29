export class Failure<F, S> {
  readonly value: F

  constructor(input: F) {
    this.value = input
  }

  public isFailure(): this is Failure<F, S> {
    return true
  }

  public isSuccess(): this is Success<F, S> {
    return false
  }
}

export class Success<F, S> {
  readonly value: S

  constructor(input: S) {
    this.value = input
  }

  public isFailure(): this is Failure<F, S> {
    return false
  }

  public isSuccess(): this is Success<F, S> {
    return true
  }
}

export type Either<F, S> = Failure<F, S> | Success<F, S>

export const failure: <F, S>(input: F) => Either<F, S> = <F, S>(input: F): Either<F, S> => {
  return new Failure<F, S>(input)
}

export const success: <F, S>(input: S) => Either<F, S> = <F, S>(input: S): Either<F, S> => {
  return new Success<F, S>(input)
}
