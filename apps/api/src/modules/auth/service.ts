import bcrypt from "bcryptjs";
import { UserDto, UserRole } from "@rideflow/shared";
import { Pool } from "pg";
import { HttpError } from "../../httpError";
import { AuthUser } from "../../middleware/auth";
import { registerDriver } from "../rides/service";

export async function registerUser(
  pool: Pool,
  input: { email: string; password: string; name: string; role: UserRole },
): Promise<UserDto> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!email.includes("@")) throw new HttpError(400, "Email is invalid");
  if (input.password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  if (!name) throw new HttpError(400, "Name is required");
  if (input.role !== "rider" && input.role !== "driver") throw new HttpError(400, "Role must be rider or driver");

  const passwordHash = await bcrypt.hash(input.password, 10);
  try {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role`,
      [email, passwordHash, name, input.role],
    );
    const user = result.rows[0] as UserDto;
    if (user.role === "driver") await registerDriver(pool, user.id);
    return user;
  } catch (err) {
    if (typeof err === "object" && err && "code" in err && (err as { code?: string }).code === "23505") {
      throw new HttpError(409, "An account with that email already exists");
    }
    throw err;
  }
}

export async function loginUser(
  pool: Pool,
  email: string,
  password: string,
): Promise<{ user: UserDto; auth: AuthUser }> {
  const { rows } = await pool.query(
    `SELECT id, email, name, role, password_hash FROM users WHERE email = $1`,
    [email.trim().toLowerCase()],
  );
  const row = rows[0] as (UserDto & { password_hash: string }) | undefined;
  if (!row) throw new HttpError(401, "Email or password is incorrect");
  const matches = await bcrypt.compare(password, row.password_hash);
  if (!matches) throw new HttpError(401, "Email or password is incorrect");
  const user = { id: row.id, email: row.email, name: row.name, role: row.role };
  return { user, auth: { id: user.id, email: user.email, role: user.role } };
}

export async function getUser(pool: Pool, userId: string): Promise<UserDto> {
  const { rows } = await pool.query(`SELECT id, email, name, role FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) throw new HttpError(404, "User not found");
  return rows[0] as UserDto;
}
