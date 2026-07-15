import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";
import { createElement, type PropsWithChildren } from "react";

const registry = AtomRegistry.make();

export function PlakkAtomProvider({ children }: PropsWithChildren) {
  return createElement(RegistryContext.Provider, { value: registry }, children);
}
