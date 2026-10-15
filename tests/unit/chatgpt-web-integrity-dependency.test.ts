import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildBridgeModuleSource,
  parsePartialChatGptWebFirstPartyModuleContract,
} from "../../open-sse/utils/chatgptWebFirstParty.ts";

// Shape of the live rspack chunk (2026-10-14): the integrity module `lXE` requires its uuid v4
// helper as `n("DD")`; earlier deployments named the same helper "TI". The bridge only shimmed
// "TI", so every turn failed with "Unsupported ChatGPT integrity dependency: DD".
function integrityChunk(dependencies: string): string {
  return [
    "export const __webpack_modules__={Xy:(function(e,t,n){var o=1}),",
    "lXE:(function(e,t,n){n.d(t,{a:()=>u,b:()=>c,c:()=>g,d:()=>m,e:()=>p,f:()=>d});",
    dependencies,
    "let r=new Map,u={},c=1;function m(){return[performance.now(),(0,a.a)()]}",
    "function p(e){return e}function g(e){return e}",
    "async function d(e){let t=m(),n=p(await e(t));return n}",
    '}),Qz:(function(e,t,n){var q=n("ZZ"),w=n("YY")})};',
  ].join("");
}

describe("ChatGPT Web integrity module dependency", () => {
  test("discovers the integrity module's uuid dependency id from the live chunk shape", () => {
    const partial = parsePartialChatGptWebFirstPartyModuleContract(
      integrityChunk('var a=n("DD");')
    );

    assert.equal(partial.resolveIntegrityModule, "lXE");
    assert.equal(partial.resolveIntegrity, "f");
    assert.equal(partial.resolveIntegrityDependency, "DD");
  });

  test("leaves the dependency unset when the module requires more than one", () => {
    const partial = parsePartialChatGptWebFirstPartyModuleContract(
      integrityChunk('var a=n("DD"),b=n("EE");')
    );

    assert.equal(partial.resolveIntegrityModule, "lXE");
    assert.equal(partial.resolveIntegrityDependency, undefined);
  });

  test("the bridge shims the discovered dependency as the uuid helper", () => {
    const source = buildBridgeModuleSource("https://chatgpt.com/cdn/assets/698524.js", {
      finalizeRequirements: "",
      proofManager: "",
      turnstileManager: "",
      requestClient: "R",
      buildSentinelHeaders: "",
      resolveIntegrity: "f",
      resolveIntegrityModule: "lXE",
      resolveIntegrityDependency: "DD",
    });

    assert.match(source, /"resolveIntegrityDependency":"DD"/);
    assert.match(
      source,
      /if \(id === "TI" \|\| id === names\.resolveIntegrityDependency\) return \{ a: \(\) => crypto\.randomUUID\(\) \};/
    );
  });
});
