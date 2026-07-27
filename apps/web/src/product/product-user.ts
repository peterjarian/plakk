import type { User } from "@plakk/shared";

type ProductUserSource = Pick<
  User,
  "createdAt" | "email" | "firstName" | "id" | "lastName" | "updatedAt"
>;

export const productUserFromAuth = (user: ProductUserSource): User => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});
