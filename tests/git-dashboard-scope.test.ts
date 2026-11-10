import { describe, expect, it } from "vitest";
import { dashboardAllows, validateDashboardRelations } from "../server/git-store/dashboardScope";
import { classes, validateRecord } from "../server/git-store/schema.mjs";

function fixture(): any {
  const records = Object.fromEntries(classes.map((k: string) => [k, {}]));
  records.users = { alice: { id: "alice" }, service: { id: "service" }, bob: { id: "bob" } };
  records.receipts = { 41: { id: 41 } };
  records.serviceDashboardPrincipals = {service: {id:"service",issuerId:"service",tenantKey:"user:alice"}};
  records.serviceDashboardBindings = {1: {
    id:1,issuerId:"service",ownerId:"alice",orgId:null,tenantKey:"user:alice",
    scope:"full-service",scopeEvidence:"fixture approval",evidence:"fixture proof",
    verifiedBy:"fixture",createdAt:"2026-11-09T00:00:00.000Z",revokedAt:null,
  }};
  return { records };
}
const receipt = { id:41,userId:"service" };
describe("Git dashboard authorization parity",()=>{
  it("isolates owners, enforces selected grants, and revokes access",()=>{
    const state=fixture(), binding=state.records.serviceDashboardBindings[1];
    expect(dashboardAllows(state,"alice",receipt)).toBe(true);
    expect(dashboardAllows(state,"bob",receipt)).toBe(false);
    binding.scope="selected"; binding.scopeEvidence=null;
    expect(dashboardAllows(state,"alice",receipt)).toBe(false);
    const grant={id:1,bindingId:1,receiptId:41,grantedBy:"fixture",revokedAt:null as string|null};
    state.records.serviceDashboardGrants[1]=grant;
    expect(dashboardAllows(state,"alice",receipt)).toBe(true);
    grant.revokedAt="2026-11-09T01:00:00.000Z";
    expect(dashboardAllows(state,"alice",receipt)).toBe(false);
    grant.revokedAt=null; binding.revokedAt="2026-11-09T01:00:00.000Z";
    expect(dashboardAllows(state,"alice",receipt)).toBe(false);
  });
  it("requires organization ownership or an accepted membership role",()=>{
    const state=fixture(), r=state.records;
    Object.assign(r.serviceDashboardBindings[1],{ownerId:null,orgId:1,tenantKey:"org:1"});
    r.serviceDashboardPrincipals.service.tenantKey="org:1";
    r.organizations[1]={id:1,ownerId:"alice"};
    expect(dashboardAllows(state,"alice",receipt)).toBe(true);
    expect(dashboardAllows(state,"bob",receipt)).toBe(false);
    r.orgMembers[1]={id:1,orgId:1,userId:"bob",role:"member"};
    expect(dashboardAllows(state,"bob",receipt)).toBe(true);
    r.orgMembers[1].role="guest";
    expect(dashboardAllows(state,"bob",receipt)).toBe(false);
  });
  it("rejects mismatched principals, duplicate bindings, orphan grants and invalid targets",()=>{
    const state=fixture(), r=state.records, binding=r.serviceDashboardBindings[1];
    expect(()=>validateDashboardRelations(state)).not.toThrow();
    r.serviceDashboardPrincipals.service.tenantKey="user:bob";
    expect(dashboardAllows(state,"alice",receipt)).toBe(false);
    expect(()=>validateDashboardRelations(state)).toThrow("principal mismatch");
    r.serviceDashboardPrincipals.service.tenantKey="user:alice";
    r.serviceDashboardBindings[2]={...binding,id:2};
    expect(()=>validateDashboardRelations(state)).toThrow("Duplicate");
    delete r.serviceDashboardBindings[2];
    r.serviceDashboardGrants[1]={id:1,bindingId:1,receiptId:999,revokedAt:null};
    expect(()=>validateDashboardRelations(state)).toThrow("Missing");
    expect(()=>validateRecord("serviceDashboardBindings",{...binding,orgId:1})).toThrow("target");
    expect(()=>validateRecord("serviceDashboardBindings",{...binding,scopeEvidence:null})).toThrow("scope");
  });
});
