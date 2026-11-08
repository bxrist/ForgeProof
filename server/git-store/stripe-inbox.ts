import Stripe from 'stripe';
import type { GitStorage } from './storage';
export interface BillingPrice { plan: 'free' | 'pro' | 'enterprise'; limit: number; keyLimit: number }
/** Explicit internal integration; no route, environment discovery, Stripe API or SQL.
 * Operator binds one trusted Stripe account, endpoint secret and reviewed price map.
 * Only fully paid recurring single-subscription invoices are supported. */
export class StripeInbox {
  private stripe = new Stripe('sk_test_offline_signature_verification_only');
  constructor(private storage: GitStorage, private secret: string, private prices: Readonly<Record<string,BillingPrice>>, private account: string | null, private now: ()=>number = Date.now) {
    if(!secret.startsWith('whsec_') || secret.length<16) throw new Error('Trusted Stripe webhook secret required');
    for(const p of Object.values(prices)) if(!['free','pro','enterprise'].includes(p.plan) || !Number.isSafeInteger(p.limit) || p.limit< -1 || !Number.isSafeInteger(p.keyLimit) || p.keyLimit< -1) throw new Error('Invalid trusted billing catalog');
  }
  async receive(raw: Buffer, signature: string) {
    if(!Buffer.isBuffer(raw) || raw.length>1024*1024 || !signature) throw new Error('Signed raw webhook bytes required');
    const now=Math.floor(this.now()/1000);
    const event=this.stripe.webhooks.constructEvent(raw,signature,this.secret,300,undefined,now*1000);
    const times=signature.split(',').filter(part=>part.startsWith('t='));
    if(times.length!==1 || !/^t=[0-9]+$/.test(times[0]) || Math.abs(Number(times[0].slice(2))-now)>300) throw new Error('Stale webhook signature timestamp');
    if(!/^evt_[a-zA-Z0-9]+$/.test(event.id) || !Number.isSafeInteger(event.created) || event.created>now+30 || event.created<now-300) throw new Error('Stale provider event');
    if((event.account ?? null)!==this.account || event.type!=='invoice.paid') throw new Error('Unexpected Stripe authority/event');
    const invoice=event.data.object as Stripe.Invoice;
    const subscription=invoice.parent?.subscription_details?.subscription;
    const lines=invoice.lines;
    if(typeof invoice.customer!=='string' || typeof subscription!=='string' || invoice.status!=='paid' || invoice.amount_remaining!==0 || invoice.billing_reason!=='subscription_cycle' || lines.has_more || lines.data.length!==1) throw new Error('Unconfirmed or unsupported invoice');
    const line=lines.data[0];
    const price=line.pricing?.price_details?.price;
    const catalog=typeof price==='string' ? this.prices[price] : undefined;
    const parent=line.parent?.subscription_item_details;
    if(!catalog || !parent || parent.subscription!==subscription || parent.proration || line.quantity!==1 || !Number.isSafeInteger(line.period.start) || !Number.isSafeInteger(line.period.end) || line.period.start>event.created+30) throw new Error('Untrusted invoice line/period');
    await this.storage.acceptStripeInvoice({id:event.id,created:event.created,customer:invoice.customer,subscription,start:line.period.start,end:line.period.end,...{plan:catalog.plan,limit:catalog.limit,keyLimit:catalog.keyLimit}});
  }
}
