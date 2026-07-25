import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";

import { Backend, BackendProvider } from "./Backend.ts";
import { RailwayApiLive } from "./RailwayApi.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Railway") {}

export const providers = () =>
  Layer.effect(Providers, Provider.collection([Backend])).pipe(
    Layer.provide(BackendProvider()),
    Layer.provideMerge(RailwayApiLive),
  );
