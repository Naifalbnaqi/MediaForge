import bcrypt from 'bcrypt';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export class BcryptPasswordHasher implements PasswordHasher {
  public constructor(private readonly rounds = 12) {}

  public hash(password: string): Promise<string> {
    return bcrypt.hash(password, this.rounds);
  }

  public verify(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }
}
