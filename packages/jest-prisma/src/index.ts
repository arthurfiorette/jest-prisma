import type { JestPrisma } from "@arthurfiorette/jest-prisma-core";
import Env from "./environment";

export const PrismaEnvironment = Env;

declare global {
  var jestPrisma: JestPrisma;
}
