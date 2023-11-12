import type { EnvironmentContext, JestEnvironment, JestEnvironmentConfig } from "@jest/environment";
import type { Circus } from "@jest/types";
import type { Prisma, PrismaClient } from "@prisma/client";
import chalk from "chalk";
import type { JestPrisma, JestPrismaEnvironmentOptions } from "./types.js";

type PartialEnvironment = Pick<JestEnvironment<unknown>, "handleTestEvent" | "teardown">;

const DEFAULT_MAX_WAIT = 5_000;
const DEFAULT_TIMEOUT = 5_000;

let CLIENT: PrismaClient<{ log: [{ level: "query"; emit: "event" }] }>;
let CLIENT_COUNT = 0;

export class PrismaEnvironmentDelegate implements PartialEnvironment {
  private clientProxy?: PrismaClient;

  private triggerTransactionEnd = () => {};

  private readonly options: JestPrismaEnvironmentOptions;

  private readonly testPath: string;

  private logBuffer?: any[];

  getClient() {
    return this.clientProxy;
  }

  constructor(config: JestEnvironmentConfig, context: EnvironmentContext) {
    this.options = config.projectConfig.testEnvironmentOptions as JestPrismaEnvironmentOptions;

    if (!CLIENT) {
      //@ts-expect-error PrismaClient is not exported as default
      const { PrismaClient } = require(this.options.prismaPath || "@prisma/client") as typeof import("@prisma/client");

      CLIENT_COUNT++;
      CLIENT = new PrismaClient({
        log: [{ level: "query", emit: "event" }],

        ...(this.options.databaseUrl && {
          datasources: {
            db: {
              url: this.options.databaseUrl,
            },
          },
        }),
      });
    }

    if (this.options.verboseQuery) {
      CLIENT.$on("query", this.logQuery);
    }

    this.testPath = context.testPath.replace(config.globalConfig.rootDir, "").slice(1);
  }

  private logQuery(event: unknown) {
    if (this.logBuffer) {
      this.logBuffer.push(event);
    }
  }

  async preSetup(): Promise<JestPrisma> {
    return {
      originalClient: CLIENT,

      client: new Proxy<PrismaClient>({} as never, {
        get: (_, name: keyof PrismaClient) => {
          if (!this.clientProxy) {
            console.warn(
              "jsetPrisma.client should be used in test or beforeEach functions because transaction has not yet started.",
            );
            console.warn(
              "If you want to access Prisma client in beforeAll or afterAll, use jestPrisma.originalClient.",
            );
          } else {
            return this.clientProxy[name];
          }
        },
      }),
    };
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

        return this.triggerTransactionEnd();

      case "run_describe_finish":
        // Ignore blocks that are already in a transaction
        if (this.isGroupedTest(event.describeBlock)) {
          break;
        }

        return this.triggerTransactionEnd();

      case "test_fn_start":
        this.logBuffer = [];
        break;

      case "test_fn_success":
      case "test_fn_failure":
        if (this.options.verboseQuery) {
          this.dumpQueryLog(event.test);
        }

        this.logBuffer = undefined;
        break;
    }
  }

  async teardown() {
    if (--CLIENT_COUNT === 0) {
      await CLIENT.$disconnect();
    }
  }

  private beginTransaction() {
    return new Promise<void>(res => {
      CLIENT.$transaction(
        async txClient => {
          this.clientProxy = createProxy(txClient);

          res();

          return new Promise<void>((resolve, reject) => {
            if (this.options.disableRollback) {
              this.triggerTransactionEnd = resolve;
            } else {
              this.triggerTransactionEnd = reject;
            }
          });
        },
        {
          maxWait: this.options.maxWait ?? DEFAULT_MAX_WAIT,
          timeout: this.options.timeout ?? DEFAULT_TIMEOUT,
        },
      );
    });
  }

  private dumpQueryLog(test: Circus.TestEntry) {
    if (!this.logBuffer) {
      return;
    }

    let parentBlock = test.parent;
    const nameFragments: string[] = [test.name];

    while (!!parentBlock) {
      nameFragments.push(parentBlock.name);
      parentBlock = parentBlock.parent!;
    }

    const breadcrumb = [this.testPath, ...nameFragments.reverse().slice(1)].join(" > ");

    console.debug(chalk.blue.bold.inverse(" QUERY ") + " " + chalk.gray(breadcrumb));

    for (const event of this.logBuffer) {
      console.debug(`${chalk.blue("  jest-prisma:query")} ${event.query}`);
    }
  }
}

function createProxy(txClient: Prisma.TransactionClient) {
  return new Proxy(txClient, {
    get: (target, name) => {
      const delegate = target[name as keyof Prisma.TransactionClient];

      if (delegate) {
        return delegate;
      }

      if (name === "$transaction") {
        return function $transaction<R>(arg: PromiseLike<R>[] | ((client: Prisma.TransactionClient) => Promise<R>)) {
          if (Array.isArray(arg)) {
            return Promise.all(arg);
          }

          return arg(txClient);
        };
      }

      throw new Error(`Unsupported property: ${name.toString()}`);
    },
  }) as PrismaClient;
}
