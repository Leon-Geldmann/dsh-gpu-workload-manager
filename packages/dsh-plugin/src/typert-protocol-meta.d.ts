/**
 * Build-only identity facade for the rc.2 Typert analyzer.
 *
 * The published rc.2 protocol tarball exposes declarations but omits its source
 * directory. The generator identifies decorator metadata by the owning ambient
 * module, so this facade supplies the exact source identities used here while
 * emitted JavaScript continues to import the real peer package.
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  import type { Context, Service } from '@deepseek-ai/cordis';

  const LOOKUP_HOST: unique symbol;
  const LOOKUP_WIRE: unique symbol;
  const CONTEXT_WIRE: unique symbol;

  export interface TypertLookup<Host, Wire> {
    readonly [LOOKUP_HOST]: Host;
    readonly [LOOKUP_WIRE]: Wire;
  }

  export interface TypertContext<Wire> {
    readonly [CONTEXT_WIRE]: Wire;
  }

  export interface TypertLookupMap {}
  export interface TypertContextMap {}

  export interface TypertGatewayBindingOptions {
    readonly namespace?: string;
  }

  export abstract class TypertRemoteService<out T = never> extends Service<T> {
    protected constructor(ctx: Context, serviceKey: string, options?: TypertGatewayBindingOptions);
  }

  type RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void;

  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void;
  export function Remote(exportName: string): RemoteMethodDecorator;
}
