import type { EnvironmentContext, JestEnvironmentConfig } from "@jest/environment";
import type { Circus } from "@jest/types";

import chalk from "chalk";

import type { JestEnvironment } from "@jest/environment";

import type { Prisma, PrismaClient } from "@prisma/client";

import type { JestPrisma, JestPrismaEnvironmentOptions } from "./types.js";

type PartialEnvironment = Pick<JestEnvironment<unknown>, "handleTestEvent" | "teardown">;

const DEFAULT_MAX_WAIT = 5_000;
const DEFAULT_TIMEOUT = 5_000;

export class PrismaEnvironmentDelegate implements PartialEnvironment {
  private prismaClientProxy: PrismaClient | undefined;
  private originalClient: PrismaClient;
  private triggerTransactionEnd: () => void = () => null;
  private readonly options: JestPrismaEnvironmentOptions;
  private readonly testPath: string;
  private logBuffer: Prisma.QueryEvent[] | undefined = undefined;

  getClient() {
    return this.prismaClientProxy;
  }

  constructor(config: JestEnvironmentConfig, context: EnvironmentContext) {
    this.options = config.projectConfig.testEnvironmentOptions as JestPrismaEnvironmentOptions;

    const { PrismaClient } = require(this.options.prismaPath || "@prisma/client") as typeof import("@prisma/client");

    const originalClient = new PrismaClient({
      log: [{ level: "query", emit: "event" }],
      ...(this.options.databaseUrl && {
        datasources: {
          db: {
            url: this.options.databaseUrl,
          },
        },
      }),
    });
    originalClient.$on("query", event => {
      this.logBuffer?.push(event);
    });
    this.originalClient = originalClient;

    this.testPath = context.testPath.replace(config.globalConfig.rootDir, "").slice(1);
  }

  async preSetup() {
    await this.originalClient.$connect();
    const hasInteractiveTransaction = await this.checkInteractiveTransaction();
    if (!hasInteractiveTransaction) {
      throw new Error(`jest-prisma needs "interactiveTransactions" preview feature.`);
    }
    const jestPrisma: JestPrisma = {
      client: new Proxy<PrismaClient>({} as never, {
        get: (_, name: keyof PrismaClient) => {
          if (!this.prismaClientProxy) {
            console.warn(
              "jsetPrisma.client should be used in test or beforeEach functions because transaction has not yet started.",
            );
            console.warn(
              "If you want to access Prisma client in beforeAll or afterAll, use jestPrisma.originalClient.",
            );
          } else {
            return this.prismaClientProxy[name];
          }
        },
      }),
      originalClient: this.originalClient,
    };
    return jestPrisma;
  }

  /**
   * If the provided describe/test block is a grouped test, and in this case, we don't want to start a transaction
   */
  isGroupedTest(parent: Circus.DescribeBlock | Circus.TestEntry) {
    while ((parent = parent.parent!)) {
      // TODO: Find better way to introduce this metadata
      if (parent.name.includes("[jest-prisma-group]")) {
        return true;
      }
    }

    return false;
  }

  handleTestEvent(event: Circus.Event) {
    switch (event.name) {
      case "test_start":
        // Ignore blocks that are already in a transaction
        if (this.isGroupedTest(event.test)) {
          break;
        }

        return this.beginTransaction();

      case "run_describe_start":
        // Ignore blocks that are already in a transaction
        if (this.isGroupedTest(event.describeBlock)) {
          break;
        }

        return this.beginTransaction();

      case "test_done":
      case "test_skip":
        // Ignore blocks that are already in a transaction
        if (this.isGroupedTest(event.test)) {
          break;
        }

        return this.endTransaction();

      case "run_describe_finish":
        // Ignore blocks that are already in a transaction
        if (this.isGroupedTest(event.describeBlock)) {
          break;
        }

        return this.endTransaction();

      case "test_fn_start":
        this.logBuffer = [];
        break;

      case "test_fn_success":
      case "test_fn_failure":
        this.dumpQueryLog(event.test);
        this.logBuffer = undefined;
        break;
    }
  }

  async teardown() {
    await this.originalClient.$disconnect();
  }

  private async checkInteractiveTransaction() {
    const checker: any = () => Promise.resolve(null);
    try {
      await this.originalClient.$transaction(checker);
      return true;
    } catch {
      return false;
    }
  }

  private async beginTransaction() {
    return new Promise<void>(resolve =>
      this.originalClient
        .$transaction(
          transactionClient => {
            this.prismaClientProxy = createProxy(transactionClient, this.originalClient);
            resolve();
            return new Promise(
              (resolve, reject) => (this.triggerTransactionEnd = this.options.disableRollback ? resolve : reject),
            );
          },
          {
            maxWait: this.options.maxWait ?? DEFAULT_MAX_WAIT,
            timeout: this.options.timeout ?? DEFAULT_TIMEOUT,
          },
        )
        .catch(() => true),
    );
  }

  private async endTransaction() {
    this.triggerTransactionEnd();
  }

  private dumpQueryLog(test: Circus.TestEntry) {
    if (this.options.verboseQuery && this.logBuffer) {
      let parentBlock: Circus.DescribeBlock | undefined | null = test.parent;
      const nameFragments: string[] = [test.name];
      while (!!parentBlock) {
        nameFragments.push(parentBlock.name);
        parentBlock = parentBlock.parent;
      }
      const breadcrumb = [this.testPath, ...nameFragments.reverse().slice(1)].join(" > ");
      console.log(chalk.blue.bold.inverse(" QUERY ") + " " + chalk.gray(breadcrumb));
      for (const event of this.logBuffer) {
        console.log(`${chalk.blue("  jest-prisma:query")} ${event.query}`);
      }
    }
  }
}

function fakeInnerTransactionFactory(parentTxClient: Prisma.TransactionClient) {
  const fakeTransactionMethod = async (
    arg: PromiseLike<unknown>[] | ((client: Prisma.TransactionClient) => Promise<unknown>),
  ) => {
    if (Array.isArray(arg)) {
      const results = [] as unknown[];
      for (const prismaPromise of arg) {
        const result = await prismaPromise;
        results.push(result);
      }
      return results;
    } else {
      return await arg(parentTxClient);
    }
  };
  return fakeTransactionMethod;
}

function createProxy(txClient: Prisma.TransactionClient, originalClient: any) {
  const boundFakeTransactionMethod = fakeInnerTransactionFactory(txClient);
  return new Proxy(txClient, {
    get: (target, name) => {
      const delegate = target[name as keyof Prisma.TransactionClient];
      if (delegate) return delegate;
      if (name === "$transaction") {
        return boundFakeTransactionMethod;
      }
      if (originalClient[name as keyof PrismaClient]) {
        throw new Error(`Unsupported property: ${name.toString()}`);
      }
    },
  }) as PrismaClient;
}
