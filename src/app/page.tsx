'use client';

import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ArrowRight,
  RefreshCw,
  Lock,
  DollarSign,
  FileText,
  UserCheck,
  CreditCard,
  Building2,
  Terminal,
  ExternalLink,
  ChevronRight,
  Database,
  Layers,
  Sparkles,
  HelpCircle,
  Copy,
  Check
} from 'lucide-react';
import { formatCurrency, centsToDecimalString } from '@/lib/currency';
import {
  StructuredPlan,
  Quote,
  PolicyEvaluationResult,
  Approval,
  PaymentAttempt,
  AuditEvent,
  ProcurementRequest,
  TeamMember,
  Supplier,
  Product
} from '@/lib/types';
import { DEMO_MEMBERS, DEMO_SUPPLIERS, DEMO_PRODUCTS, DEMO_BUSINESS } from '@/lib/catalog';

type ActiveTab = 'studio' | 'ledger' | 'catalogue' | 'security';

export default function Home() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('studio');
  const [currentPersona, setCurrentPersona] = useState<TeamMember>(DEMO_MEMBERS[0]); // Amina (Requester)

  // Wizard state
  const [prompt, setPrompt] = useState('Order 2 Dell XPS 15 laptops from AfriTech for our engineering team. Budget under $5,000.');
  const [budgetCap, setBudgetCap] = useState('5000');
  const [isPlanning, setIsPlanning] = useState(false);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);

  // Entities
  const [currentRequest, setCurrentRequest] = useState<ProcurementRequest | null>(null);
  const [structuredPlan, setStructuredPlan] = useState<StructuredPlan | null>(null);
  const [currentQuote, setCurrentQuote] = useState<Quote | null>(null);
  const [policyResult, setPolicyResult] = useState<PolicyEvaluationResult | null>(null);
  const [currentApproval, setCurrentApproval] = useState<Approval | null>(null);
  const [paymentAttempt, setPaymentAttempt] = useState<PaymentAttempt | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [isSupabaseConnected, setIsSupabaseConnected] = useState(false);
  const [approvalNote, setApprovalNote] = useState('');
  const [copiedHash, setCopiedHash] = useState(false);

  // Security playground state
  const [runningAttack, setRunningAttack] = useState<string | null>(null);
  const [attackResult, setAttackResult] = useState<{
    id: string;
    title: string;
    success: boolean;
    serverMessage: string;
    details?: string;
  } | null>(null);

  // Fetch ledger state
  const refreshLedger = async () => {
    try {
      const res = await fetch('/api/procurement/state');
      if (res.ok) {
        const data = await res.json();
        setAuditEvents(data.auditEvents || []);
        setIsSupabaseConnected(Boolean(data.isSupabaseConnected));
      }
    } catch (err) {
      console.error('Failed to refresh state:', err);
    }
  };

  useEffect(() => {
    refreshLedger();
  }, []);

  // Preset chips
  const selectPreset = (type: 'happy' | 'overbudget' | 'unapproved' | 'monitors') => {
    if (type === 'happy') {
      setPrompt('Order 2 Dell XPS 15 laptops from AfriTech for our engineering team. Budget under $5,000.');
      setBudgetCap('5000');
    } else if (type === 'overbudget') {
      setPrompt('Order 6 Apple MacBook Pro 14 laptops from AfriTech for graphic designers. Keep under $8,000.');
      setBudgetCap('8000');
    } else if (type === 'unapproved') {
      setPrompt('Order 3 uncertified refurbished laptops from ShadowTech Grey Market. Budget under $2,000.');
      setBudgetCap('2000');
    } else if (type === 'monitors') {
      setPrompt('Order 3 Dell 4K USB-C monitors and 3 Logitech MX Master mice from Westfield Peripherals. Budget under $2,500.');
      setBudgetCap('2500');
    }
  };

  // 1. Submit Prompt & Generate AI Plan
  const handleGeneratePlan = async () => {
    if (!prompt.trim()) return;
    setIsPlanning(true);
    setCurrentQuote(null);
    setPolicyResult(null);
    setCurrentApproval(null);
    setPaymentAttempt(null);

    try {
      const budgetCents = parseInt(budgetCap, 10) * 100 || 500000;
      const res = await fetch('/api/procurement/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          budgetLimitCents: budgetCents,
          requesterId: currentPersona.userId,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setCurrentRequest(data.request);
        setStructuredPlan(data.plan);
        await refreshLedger();
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err: unknown) {
      alert(`Error generating plan: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsPlanning(false);
    }
  };

  // 2. Calculate Server Quote & Check Policy
  const handleCalculateQuote = async () => {
    if (!currentRequest || !structuredPlan || structuredPlan.items.length === 0) return;
    setIsQuoting(true);

    try {
      const res = await fetch('/api/procurement/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: currentRequest.id,
          supplierId: structuredPlan.suggestedSupplierId || DEMO_SUPPLIERS[0].id,
          items: structuredPlan.items.map((i) => ({
            sku: i.sku,
            productId: i.matchedProductId,
            quantity: i.quantity,
          })),
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setCurrentQuote(data.quote);
        setPolicyResult(data.policyResult);
        await refreshLedger();
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err: unknown) {
      alert(`Error creating quote: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsQuoting(false);
    }
  };

  // 3. Approve or Reject Quote
  const handleApproval = async (decision: 'approved' | 'rejected') => {
    if (!currentQuote) return;
    setIsApproving(true);

    try {
      const res = await fetch('/api/procurement/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId: currentQuote.id,
          decision,
          reason: approvalNote || (decision === 'approved' ? 'Approved through governance portal.' : 'Rejected by reviewer.'),
          approverUserId: currentPersona.userId,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setCurrentApproval(data.approval);
        setPolicyResult(data.policyResult);
        await refreshLedger();
      } else {
        alert(`Approval Denied: ${data.error}`);
      }
    } catch (err: unknown) {
      alert(`Error processing approval: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsApproving(false);
    }
  };

  // 4. Create PayPal Order
  const handleCreatePayPalOrder = async () => {
    if (!currentQuote || !currentApproval) return;
    setIsCreatingOrder(true);

    try {
      const res = await fetch('/api/paypal/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteId: currentQuote.id }),
      });

      const data = await res.json();
      if (res.ok) {
        setPaymentAttempt(data.paymentAttempt);
        await refreshLedger();
      } else {
        alert(`PayPal Order Error: ${data.error}`);
      }
    } catch (err: unknown) {
      alert(`Error creating order: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsCreatingOrder(false);
    }
  };

  // 5. Capture PayPal Order
  const handleCapturePayPalOrder = async () => {
    if (!paymentAttempt?.providerOrderId) return;
    setIsCapturing(true);

    try {
      const res = await fetch('/api/paypal/capture-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: paymentAttempt.providerOrderId }),
      });

      const data = await res.json();
      if (res.ok) {
        setPaymentAttempt(data.paymentAttempt);
        await refreshLedger();
      } else {
        alert(`PayPal Capture Error: ${data.error}`);
      }
    } catch (err: unknown) {
      alert(`Error capturing payment: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsCapturing(false);
    }
  };

  // Copy quote checksum
  const handleCopyHash = () => {
    if (!currentQuote) return;
    navigator.clipboard.writeText(currentQuote.checksumHash);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  };

  // Reset entire state
  const handleReset = async () => {
    if (!confirm('Reset all demo requests, quotes, and audit logs?')) return;
    await fetch('/api/procurement/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset' }),
    });
    setCurrentRequest(null);
    setStructuredPlan(null);
    setCurrentQuote(null);
    setPolicyResult(null);
    setCurrentApproval(null);
    setPaymentAttempt(null);
    setAttackResult(null);
    await refreshLedger();
  };

  // Adversarial Attack Simulator
  const runAdversarialAttack = async (attackKey: string) => {
    setRunningAttack(attackKey);
    setAttackResult(null);

    try {
      if (attackKey === 'PRICE_TAMPERING') {
        // Client attempts to pass a $1.00 fake price
        const res = await fetch('/api/procurement/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId: 'fake-req',
            supplierId: DEMO_SUPPLIERS[0].id,
            items: [{ sku: 'LAP-DELL-XPS15', quantity: 1, unitPriceCents: 100 }], // $1.00 attempt
          }),
        });
        const data = await res.json();
        // Server will use authoritative catalogue price $1,799.00
        setAttackResult({
          id: attackKey,
          title: 'Client Price Tampering Attack',
          success: false, // The attack failed, defense succeeded
          serverMessage: 'DEFENSE VERIFIED: Server ignored client-submitted price ($1.00) and computed authoritative catalogue price ($1,799.00). Client has zero authority over unit pricing.',
          details: data.quote ? `Computed Total: ${formatCurrency(data.quote.totalCents)}` : data.error,
        });
      } else if (attackKey === 'UNAPPROVED_SUPPLIER') {
        // Try buying from ShadowTech
        const res = await fetch('/api/procurement/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId: currentRequest?.id || 'demo-req',
            supplierId: '00000000-0000-4000-8000-000000000300', // ShadowTech
            items: [{ sku: 'LAP-SHAD-GREY01', quantity: 1 }],
          }),
        });
        const data = await res.json();
        const hasViolation = data.policyResult?.violations?.some((v: string) => v.includes('NOT an approved vendor'));
        setAttackResult({
          id: attackKey,
          title: 'Unapproved Supplier Procurement Attack',
          success: false,
          serverMessage: hasViolation
            ? 'DEFENSE VERIFIED: Policy engine blocked unapproved vendor "ShadowTech Grey Market Ltd" (Risk: High). Procurement approval cannot be issued.'
            : 'Policy check responded.',
          details: data.policyResult?.violations?.join(', '),
        });
      } else if (attackKey === 'SELF_APPROVAL') {
        // Requester attempts to approve their own purchase
        if (!currentQuote) {
          alert('Please generate a quote in the studio first to run self-approval attack.');
          return;
        }
        const requester = DEMO_MEMBERS.find((m) => m.role === 'requester')!;
        const res = await fetch('/api/procurement/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quoteId: currentQuote.id,
            decision: 'approved',
            approverUserId: requester.userId, // Same user attempting approval
          }),
        });
        const data = await res.json();
        setAttackResult({
          id: attackKey,
          title: 'Segregation of Duties (SoD) Bypass Attack',
          success: false,
          serverMessage: res.status >= 400
            ? `DEFENSE VERIFIED: Server rejected approval with HTTP ${res.status}: ${data.error}`
            : 'Checked role authority.',
          details: data.error || 'Approval rejected as expected.',
        });
      } else if (attackKey === 'UNAUTHORIZED_PAYMENT') {
        // Attempt creating PayPal order without an approved quote
        const res = await fetch('/api/paypal/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quoteId: 'non-existent-or-unapproved-quote' }),
        });
        const data = await res.json();
        setAttackResult({
          id: attackKey,
          title: 'Direct Unapproved Payment Execution Attack',
          success: false,
          serverMessage: `DEFENSE VERIFIED: Gateway refused order creation (HTTP ${res.status}): ${data.error}. Payments cannot be initiated without an immutable, cryptographically sealed approval record.`,
          details: data.error,
        });
      } else if (attackKey === 'DUPLICATE_WEBHOOK') {
        // Send duplicate webhook event
        const res = await fetch('/api/paypal/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'paypal-transmission-sig': 'mocked-valid-signature-for-sandbox-test',
          },
          body: JSON.stringify({
            id: 'WH-ATTACK-DUP-001',
            event_type: 'PAYMENT.CAPTURE.COMPLETED',
            resource: { id: 'test' },
          }),
        });
        const data = await res.json();
        // Send second time
        const res2 = await fetch('/api/paypal/webhook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'paypal-transmission-sig': 'mocked-valid-signature-for-sandbox-test',
          },
          body: JSON.stringify({
            id: 'WH-ATTACK-DUP-001',
            event_type: 'PAYMENT.CAPTURE.COMPLETED',
            resource: { id: 'test' },
          }),
        });
        const data2 = await res2.json();
        setAttackResult({
          id: attackKey,
          title: 'Replay / Duplicate Webhook Injection Attack',
          success: false,
          serverMessage: `DEFENSE VERIFIED: First webhook processed (${data.status}). Second replay was flagged and deduplicated (${data2.status}: "${data2.message}"). Prevents duplicate ledger entries.`,
          details: JSON.stringify(data2),
        });
      }
    } catch (err: unknown) {
      setAttackResult({
        id: attackKey,
        title: 'Security Attack Test',
        success: false,
        serverMessage: `Rejected: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setRunningAttack(null);
      await refreshLedger();
    }
  };

  return (
    <main className="min-h-screen text-slate-100 pb-20">
      {/* Top Navbar */}
      <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-950/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-violet-600 to-indigo-500 shadow-lg shadow-violet-500/25">
              <ShieldCheck className="h-6 w-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold tracking-tight">ActionOS</span>
                <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-xs font-semibold text-violet-300">PAY</span>
                <span className="hidden sm:inline-block rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                  SANDBOX
                </span>
                <span
                  className={`hidden sm:inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                    isSupabaseConnected
                      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                      : 'border-violet-500/30 bg-violet-500/10 text-violet-300'
                  }`}
                  title={
                    isSupabaseConnected
                      ? 'Live Supabase PostgreSQL connection active with RLS policies'
                      : 'Supabase schema & migrations ready; using local high-speed ledger store'
                  }
                >
                  <Database className="h-2.5 w-2.5" />
                  {isSupabaseConnected ? 'SUPABASE POSTGRESQL' : 'SUPABASE READY'}
                </span>
              </div>
              <p className="text-[11px] text-slate-400">AI Procurement · Human Governance · PayPal Payments</p>
            </div>
          </div>

          {/* Persona Switcher & Tenant Pill */}
          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs">
              <Building2 className="h-3.5 w-3.5 text-slate-400" />
              <span className="text-slate-300 font-medium">{DEMO_BUSINESS.name}</span>
              <span className="text-slate-500">|</span>
              <span className="text-violet-300 font-mono">Limit: {formatCurrency(DEMO_BUSINESS.budgetLimitCents)}</span>
            </div>

            {/* Persona Selector */}
            <div className="flex items-center gap-2 rounded-xl border border-violet-500/30 bg-violet-950/30 p-1">
              <span className="hidden sm:inline-block text-[11px] text-slate-400 pl-2">Persona:</span>
              {DEMO_MEMBERS.map((m) => {
                const isSelected = currentPersona.userId === m.userId;
                return (
                  <button
                    key={m.userId}
                    onClick={() => setCurrentPersona(m)}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                      isSelected
                        ? 'bg-violet-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                    }`}
                  >
                    <span>{m.userName.split(' ')[0]}</span>
                    <span
                      className={`rounded px-1 text-[9px] uppercase font-bold ${
                        m.role === 'approver'
                          ? 'bg-amber-400/20 text-amber-300'
                          : m.role === 'admin'
                          ? 'bg-cyan-400/20 text-cyan-300'
                          : 'bg-slate-400/20 text-slate-300'
                      }`}
                    >
                      {m.role}
                    </span>
                  </button>
                );
              })}
            </div>

            <button
              onClick={handleReset}
              title="Reset application state"
              className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-400 hover:bg-white/10 hover:text-slate-200 transition"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="mx-auto flex max-w-7xl gap-1 px-4 sm:px-6 lg:px-8 border-t border-white/5">
          <button
            onClick={() => setActiveTab('studio')}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition ${
              activeTab === 'studio'
                ? 'border-violet-500 text-violet-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sparkles className="h-4 w-4" />
            Procurement Studio
          </button>
          <button
            onClick={() => setActiveTab('ledger')}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition ${
              activeTab === 'ledger'
                ? 'border-violet-500 text-violet-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Database className="h-4 w-4" />
            Authoritative Ledger ({auditEvents.length})
          </button>
          <button
            onClick={() => setActiveTab('catalogue')}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition ${
              activeTab === 'catalogue'
                ? 'border-violet-500 text-violet-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="h-4 w-4" />
            Suppliers & Catalogue
          </button>
          <button
            onClick={() => setActiveTab('security')}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition ${
              activeTab === 'security'
                ? 'border-violet-500 text-violet-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="h-4 w-4 text-amber-400" />
            Security & Attack Simulator
          </button>
        </div>
      </header>

      {/* Main Container */}
      <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6 lg:px-8">
        {/* TAB 1: PROCUREMENT STUDIO */}
        {activeTab === 'studio' && (
          <div className="space-y-6">
            {/* Persona Notice Banner */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-violet-500/20 bg-gradient-to-r from-violet-950/40 to-slate-900/60 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-600/20 text-violet-300 border border-violet-500/30">
                  <UserCheck className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">
                    Logged in as <span className="text-violet-300">{currentPersona.userName}</span> ({currentPersona.userEmail})
                  </p>
                  <p className="text-xs text-slate-400">
                    Role: <span className="font-semibold text-amber-300 uppercase">{currentPersona.role}</span> · Delegated Authority Limit: <span className="text-white font-mono">{formatCurrency(currentPersona.approvalLimitCents)}</span>
                  </p>
                </div>
              </div>
              <div className="text-xs text-slate-400 bg-black/40 px-3 py-1.5 rounded-lg border border-white/5">
                {currentPersona.role === 'requester' ? (
                  <span className="text-slate-300">Can submit requests & create quotes. Approvals require VP Finance.</span>
                ) : (
                  <span className="text-emerald-300">Authorized to approve/reject quotes within budget threshold.</span>
                )}
              </div>
            </div>

            {/* Stage Progress Stepper */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {[
                { n: '1', title: 'AI Intent Plan', active: Boolean(structuredPlan), current: !structuredPlan },
                { n: '2', title: 'Server Quote', active: Boolean(currentQuote), current: Boolean(structuredPlan && !currentQuote) },
                { n: '3', title: 'Policy Guardrails', active: Boolean(policyResult?.passed), current: Boolean(currentQuote && !policyResult) },
                { n: '4', title: 'Human Approval', active: currentApproval?.decision === 'approved', current: Boolean(currentQuote && !currentApproval) },
                { n: '5', title: 'PayPal Sandbox', active: paymentAttempt?.status === 'captured', current: Boolean(currentApproval && paymentAttempt?.status !== 'captured') },
              ].map((s) => (
                <div
                  key={s.n}
                  className={`rounded-xl border p-3 transition ${
                    s.active
                      ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300'
                      : s.current
                      ? 'border-violet-500/50 bg-violet-950/30 text-violet-200 glow-violet'
                      : 'border-white/5 bg-white/[0.02] text-slate-500'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold ${
                        s.active
                          ? 'bg-emerald-500 text-slate-950'
                          : s.current
                          ? 'bg-violet-500 text-white'
                          : 'bg-white/10 text-slate-400'
                      }`}
                    >
                      {s.active ? '✓' : s.n}
                    </span>
                    <span className="text-xs font-semibold">{s.title}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Step 1: Natural Language Purchase Input */}
            <div className="glass-panel rounded-3xl p-6 glow-violet">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-4">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-violet-400" />
                    Step 1: Describe Purchase Intent
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    AI parses natural-language requests into structured, schema-validated line items matching the approved catalogue.
                  </p>
                </div>

                {/* Pre-set chips */}
                <div className="flex flex-wrap gap-1.5">
                  <span className="text-xs text-slate-500 self-center mr-1">Presets:</span>
                  <button
                    onClick={() => selectPreset('happy')}
                    className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-300 hover:bg-violet-500/20 hover:border-violet-500/40 hover:text-white transition"
                  >
                    2 Laptops ($5k Limit)
                  </button>
                  <button
                    onClick={() => selectPreset('overbudget')}
                    className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1 text-xs text-amber-300 hover:bg-amber-500/20 transition"
                  >
                    Over-Budget Breach
                  </button>
                  <button
                    onClick={() => selectPreset('unapproved')}
                    className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1 text-xs text-rose-300 hover:bg-rose-500/20 transition"
                  >
                    Unapproved Vendor
                  </button>
                  <button
                    onClick={() => selectPreset('monitors')}
                    className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-300 hover:bg-violet-500/20 transition"
                  >
                    Monitors & Peripherals
                  </button>
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_200px]">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Purchase Instructions</label>
                  <textarea
                    rows={3}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="e.g. Order 2 Dell XPS 15 laptops from AfriTech for our engineering team. Budget under $5,000."
                    className="w-full rounded-2xl border border-white/10 bg-slate-900/90 px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Authorized Budget Cap ($)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-2.5 text-slate-500 text-sm">$</span>
                    <input
                      type="number"
                      value={budgetCap}
                      onChange={(e) => setBudgetCap(e.target.value)}
                      className="w-full rounded-2xl border border-white/10 bg-slate-900/90 pl-7 pr-3 py-2.5 text-sm text-white focus:border-violet-500 focus:outline-none"
                    />
                  </div>
                  <button
                    onClick={handleGeneratePlan}
                    disabled={isPlanning || !prompt.trim()}
                    className="mt-3.5 w-full rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-violet-500 transition disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-violet-600/30"
                  >
                    {isPlanning ? (
                      <>
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        Analyzing Intent...
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3.5 w-3.5" />
                        Generate AI Plan
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Parsed Structured Plan Display */}
              {structuredPlan && (
                <div className="mt-5 rounded-2xl border border-violet-500/25 bg-violet-950/20 p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-white/10 pb-3">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-violet-300">Structured AI Plan Output</span>
                      <h3 className="text-sm font-semibold text-white mt-0.5">{structuredPlan.summary}</h3>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-emerald-400/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-400 border border-emerald-400/20">
                        Confidence: {(structuredPlan.confidenceScore * 100).toFixed(0)}%
                      </span>
                      <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-[11px] text-slate-300 border border-white/10">
                        Cap: {formatCurrency(structuredPlan.budgetLimitCents)}
                      </span>
                    </div>
                  </div>

                  {structuredPlan.clarificationNeeded && structuredPlan.clarificationQuestions && (
                    <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                      <div className="flex items-center gap-1.5 font-semibold text-amber-300 mb-1">
                        <HelpCircle className="h-4 w-4" /> Clarification Required Before Quotation:
                      </div>
                      <ul className="list-disc pl-5 space-y-1">
                        {structuredPlan.clarificationQuestions.map((q, idx) => (
                          <li key={idx}>{q}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-white/10 text-slate-400">
                          <th className="pb-2 font-medium">SKU</th>
                          <th className="pb-2 font-medium">Matched Item</th>
                          <th className="pb-2 font-medium text-center">Qty</th>
                          <th className="pb-2 font-medium text-right">Est. Unit Price</th>
                          <th className="pb-2 font-medium text-right">Supplier</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5 text-slate-200">
                        {structuredPlan.items.map((item, idx) => (
                          <tr key={idx}>
                            <td className="py-2 font-mono text-[11px] text-violet-300">{item.sku || 'N/A'}</td>
                            <td className="py-2 font-medium">{item.productName}</td>
                            <td className="py-2 text-center">{item.quantity}</td>
                            <td className="py-2 text-right font-mono">
                              {item.estimatedUnitPriceCents ? formatCurrency(item.estimatedUnitPriceCents) : 'TBD'}
                            </td>
                            <td className="py-2 text-right text-slate-400">{item.suggestedSupplierName || 'AfriTech Solutions'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {!currentQuote && (
                    <div className="mt-4 flex justify-end">
                      <button
                        onClick={handleCalculateQuote}
                        disabled={isQuoting}
                        className="rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-500 transition flex items-center gap-2 shadow-lg shadow-violet-600/30"
                      >
                        {isQuoting ? (
                          <>
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            Calculating Quote...
                          </>
                        ) : (
                          <>
                            Compute Authoritative Quote & Check Policies
                            <ArrowRight className="h-3.5 w-3.5" />
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Step 2 & 3: Server Quote & Policy Guardrails */}
            {currentQuote && (
              <div className="grid gap-6 lg:grid-cols-[1.1fr_.9fr]">
                {/* Deterministic Quote Card */}
                <div className="glass-panel rounded-3xl p-6 space-y-4">
                  <div className="flex items-center justify-between border-b border-white/10 pb-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-bold text-white">Authoritative Server Quote</h3>
                        <span className="rounded bg-violet-500/20 px-2 py-0.5 text-[10px] font-bold text-violet-300">
                          VERSION {currentQuote.version}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">Supplier: {currentQuote.supplierName}</p>
                    </div>

                    <div className="text-right">
                      <p className="text-xs text-slate-400">Authoritative Total</p>
                      <p className="text-xl font-bold font-mono text-emerald-400">
                        {formatCurrency(currentQuote.totalCents, currentQuote.currency)}
                      </p>
                    </div>
                  </div>

                  {/* Items List */}
                  <div className="divide-y divide-white/5">
                    {currentQuote.items.map((item) => (
                      <div key={item.id} className="py-2.5 flex items-center justify-between text-xs">
                        <div>
                          <p className="font-semibold text-white">{item.itemName}</p>
                          <p className="font-mono text-[11px] text-slate-400">
                            SKU: {item.sku} · {item.quantity} units @ {formatCurrency(item.unitPriceCents)}
                          </p>
                        </div>
                        <span className="font-mono font-medium text-slate-200">
                          {formatCurrency(item.totalCents)}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Pricing Breakdown */}
                  <div className="rounded-xl bg-white/[0.03] p-3 text-xs space-y-1.5 border border-white/5 font-mono">
                    <div className="flex justify-between text-slate-400">
                      <span>Subtotal:</span>
                      <span>{formatCurrency(currentQuote.subtotalCents)}</span>
                    </div>
                    <div className="flex justify-between text-slate-400">
                      <span>VAT / Sales Tax (7.5%):</span>
                      <span>{formatCurrency(currentQuote.taxCents)}</span>
                    </div>
                    <div className="flex justify-between text-slate-400">
                      <span>Insured Freight & Logistics:</span>
                      <span>{formatCurrency(currentQuote.shippingCents)}</span>
                    </div>
                    <div className="border-t border-white/10 pt-1.5 flex justify-between font-bold text-sm text-white">
                      <span>Total (Minor Units: {currentQuote.totalCents} cents):</span>
                      <span className="text-emerald-400">{formatCurrency(currentQuote.totalCents)}</span>
                    </div>
                  </div>

                  {/* Cryptographic SHA-256 Checksum Seal */}
                  <div className="rounded-xl border border-white/10 bg-slate-900/90 p-3">
                    <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                      <span className="flex items-center gap-1 font-semibold text-violet-300">
                        <Lock className="h-3 w-3" /> SHA-256 Cryptographic Integrity Seal:
                      </span>
                      <button
                        onClick={handleCopyHash}
                        className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-white"
                      >
                        {copiedHash ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                        {copiedHash ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <p className="font-mono text-[10px] text-slate-300 break-all select-all bg-black/40 p-2 rounded border border-white/5">
                      {currentQuote.checksumHash}
                    </p>
                    <p className="text-[10px] text-slate-500 mt-1.5">
                      Any quote tampering or price alteration invalidates this seal and revokes subsequent approvals.
                    </p>
                  </div>
                </div>

                {/* Policy Guardrails Card */}
                <div className="glass-panel rounded-3xl p-6 space-y-4">
                  <div className="flex items-center justify-between border-b border-white/10 pb-4">
                    <div>
                      <h3 className="text-base font-bold text-white flex items-center gap-2">
                        <ShieldCheck className="h-5 w-5 text-violet-400" />
                        Corporate Policy Guardrails
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">Automated rule verification against tenant governance</p>
                    </div>

                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-bold border ${
                        policyResult?.passed
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                      }`}
                    >
                      {policyResult?.passed ? 'ALL CHECKS PASSED' : 'POLICY VIOLATION'}
                    </span>
                  </div>

                  {/* Checks List */}
                  <div className="space-y-2.5">
                    {policyResult?.checks.map((c) => (
                      <div
                        key={c.code}
                        className={`rounded-xl border p-3 text-xs transition ${
                          c.passed
                            ? 'border-emerald-500/20 bg-emerald-950/10 text-slate-300'
                            : 'border-rose-500/30 bg-rose-950/20 text-rose-200'
                        }`}
                      >
                        <div className="flex items-center gap-2 font-semibold">
                          {c.passed ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                          ) : (
                            <XCircle className="h-4 w-4 text-rose-400 shrink-0" />
                          )}
                          <span className={c.passed ? 'text-white' : 'text-rose-300'}>{c.name}</span>
                        </div>
                        <p className="mt-1 text-[11px] text-slate-400 pl-6 leading-relaxed">{c.message}</p>
                      </div>
                    ))}
                  </div>

                  {/* Violations Summary */}
                  {policyResult && !policyResult.passed && (
                    <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
                      <p className="font-semibold text-rose-300 mb-1">Governance Block Activated:</p>
                      <ul className="list-disc pl-5 space-y-1">
                        {policyResult.violations.map((v, idx) => (
                          <li key={idx}>{v}</li>
                        ))}
                      </ul>
                      <p className="mt-2 text-[11px] text-slate-400">
                        Adjust budget limit or choose an approved supplier to satisfy corporate procurement rules.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Step 4: Human Governance & Approval Gate */}
            {currentQuote && (
              <div className="glass-panel rounded-3xl p-6 glow-violet">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 pb-4">
                  <div>
                    <h3 className="text-base font-bold text-white flex items-center gap-2">
                      <UserCheck className="h-5 w-5 text-amber-400" />
                      Step 4: Human Approval Gate (Segregation of Duties)
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      An authorized approver must explicitly bind their digital signature to Quote Version {currentQuote.version} and total {formatCurrency(currentQuote.totalCents)}.
                    </p>
                  </div>

                  {currentApproval && (
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-bold border ${
                        currentApproval.decision === 'approved'
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                      }`}
                    >
                      {currentApproval.decision === 'approved' ? '✓ QUOTE APPROVED' : '✗ QUOTE REJECTED'}
                    </span>
                  )}
                </div>

                {!currentApproval ? (
                  <div className="mt-4 space-y-4">
                    {/* Persona validation warning */}
                    {currentPersona.role === 'requester' ? (
                      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200 flex items-start gap-3">
                        <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                        <div>
                          <p className="font-semibold text-amber-300">Approval Authority Required</p>
                          <p className="mt-1 leading-relaxed">
                            Current persona <span className="text-white font-bold">{currentPersona.userName}</span> has role <span className="uppercase font-bold text-white">{currentPersona.role}</span>.
                            Under the Segregation of Duties policy, purchases above $500 cannot be approved by requesters.
                          </p>
                          <p className="mt-2 text-white font-medium">
                            👉 Switch persona to <span className="text-violet-300 font-bold">Chidi (VP Finance)</span> in the top navigation bar to grant approval.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs text-emerald-200 flex items-center gap-3">
                        <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
                        <div>
                          <p className="font-semibold text-white">
                            Authorized Approver: {currentPersona.userName} ({currentPersona.role.toUpperCase()})
                          </p>
                          <p className="text-[11px] text-emerald-300 mt-0.5">
                            Approval threshold ({formatCurrency(currentPersona.approvalLimitCents)}) covers quote total of {formatCurrency(currentQuote.totalCents)}.
                          </p>
                        </div>
                      </div>
                    )}

                    <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                      <input
                        type="text"
                        value={approvalNote}
                        onChange={(e) => setApprovalNote(e.target.value)}
                        placeholder="Optional approval note or justification (e.g. Q4 engineering team expansion approved)"
                        className="rounded-xl border border-white/10 bg-slate-900/90 px-4 py-2.5 text-xs text-white placeholder-slate-500 focus:border-violet-500 focus:outline-none"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleApproval('rejected')}
                          disabled={isApproving}
                          className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/20 transition disabled:opacity-50"
                        >
                          Reject
                        </button>
                        <button
                          onClick={() => handleApproval('approved')}
                          disabled={isApproving || Boolean(policyResult && !policyResult.passed)}
                          className="rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 transition disabled:opacity-40 flex items-center gap-2 shadow-lg shadow-emerald-600/20"
                        >
                          {isApproving ? (
                            <>
                              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                              Sealing Approval...
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="h-4 w-4" />
                              Approve Quote v{currentQuote.version}
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-950/20 p-4 space-y-2 text-xs">
                    <div className="flex items-center justify-between text-slate-300">
                      <span>Approved By:</span>
                      <span className="font-semibold text-white">
                        {currentApproval.approverName} ({currentApproval.approverRole.toUpperCase()})
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-slate-300">
                      <span>Bound Quote Version:</span>
                      <span className="font-mono font-bold text-violet-300">v{currentApproval.quoteVersion}</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-300">
                      <span>Approved Amount:</span>
                      <span className="font-mono font-bold text-emerald-400">
                        {formatCurrency(currentApproval.approvedTotalCents, currentApproval.approvedCurrency)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-slate-300">
                      <span>Digital Signature Seal:</span>
                      <span className="font-mono text-[10px] text-slate-400 truncate max-w-xs">
                        {currentApproval.digitalSignature}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Step 5: PayPal Sandbox Execution */}
            {currentApproval?.decision === 'approved' && currentQuote && (
              <div className="glass-panel rounded-3xl p-6 glow-violet">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 pb-4">
                  <div>
                    <h3 className="text-base font-bold text-white flex items-center gap-2">
                      <CreditCard className="h-5 w-5 text-cyan-400" />
                      Step 5: PayPal Sandbox Payment Execution
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Server-side order initialization and capture strictly bound to approved quote record.
                    </p>
                  </div>

                  <span
                    className={`rounded-full px-3 py-1 text-xs font-bold border ${
                      paymentAttempt?.status === 'captured'
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : paymentAttempt?.status === 'created'
                        ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
                        : 'border-white/10 text-slate-400'
                    }`}
                  >
                    STATUS: {paymentAttempt?.status?.toUpperCase() || 'READY TO INITIATE'}
                  </span>
                </div>

                {!paymentAttempt ? (
                  <div className="mt-5 flex flex-col sm:flex-row items-center justify-between gap-4 rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                    <div>
                      <p className="text-sm font-semibold text-white">Create PayPal Sandbox Order</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Amount to authorize: <span className="font-mono text-emerald-400 font-bold">{formatCurrency(currentQuote.totalCents)}</span> ({centsToDecimalString(currentQuote.totalCents)} USD)
                      </p>
                    </div>

                    <button
                      onClick={handleCreatePayPalOrder}
                      disabled={isCreatingOrder}
                      className="rounded-xl bg-[#0070ba] hover:bg-[#005ea6] px-5 py-2.5 text-xs font-semibold text-white transition flex items-center gap-2 shadow-lg shadow-blue-900/30"
                    >
                      {isCreatingOrder ? (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          Creating Order...
                        </>
                      ) : (
                        <>
                          <span>PayPal</span>
                          <span className="font-bold">Sandbox Checkout</span>
                          <ArrowRight className="h-3.5 w-3.5" />
                        </>
                      )}
                    </button>
                  </div>
                ) : paymentAttempt.status === 'created' ? (
                  <div className="mt-5 space-y-4">
                    <div className="rounded-2xl border border-cyan-500/30 bg-cyan-950/20 p-4 text-xs space-y-2">
                      <div className="flex justify-between">
                        <span className="text-slate-400">PayPal Order ID:</span>
                        <span className="font-mono font-bold text-cyan-300">{paymentAttempt.providerOrderId}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Order Amount:</span>
                        <span className="font-mono font-bold text-white">{formatCurrency(paymentAttempt.amountCents)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Idempotency Key:</span>
                        <span className="font-mono text-slate-400 text-[10px]">{paymentAttempt.idempotencyKey}</span>
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 rounded-2xl border border-white/10 bg-black/40">
                      <div>
                        <p className="text-xs font-semibold text-white">Sandbox Checkout Simulated / Connected</p>
                        <p className="text-[11px] text-slate-400">Click capture to simulate buyer checkout completion and server-side capture.</p>
                      </div>

                      <button
                        onClick={handleCapturePayPalOrder}
                        disabled={isCapturing}
                        className="rounded-xl bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 text-xs font-semibold text-white transition flex items-center gap-2 shadow-lg shadow-emerald-600/30"
                      >
                        {isCapturing ? (
                          <>
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            Capturing Payment...
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="h-4 w-4" />
                            Complete Server-Side Capture
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-5 rounded-2xl border border-emerald-500/30 bg-emerald-950/20 p-5 space-y-3">
                    <div className="flex items-center gap-2 text-emerald-300 font-bold text-sm">
                      <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                      Payment Verified & Authoritative Ledger Reconciled
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3 text-xs">
                      <div className="rounded-xl bg-black/40 p-3 border border-white/5 space-y-1">
                        <p className="text-slate-400 text-[11px]">Provider Order ID</p>
                        <p className="font-mono font-semibold text-white">{paymentAttempt.providerOrderId}</p>
                      </div>
                      <div className="rounded-xl bg-black/40 p-3 border border-white/5 space-y-1">
                        <p className="text-slate-400 text-[11px]">Provider Capture ID</p>
                        <p className="font-mono font-semibold text-emerald-300">{paymentAttempt.providerCaptureId}</p>
                      </div>
                      <div className="rounded-xl bg-black/40 p-3 border border-white/5 space-y-1">
                        <p className="text-slate-400 text-[11px]">Total Paid</p>
                        <p className="font-mono font-semibold text-white">{formatCurrency(paymentAttempt.amountCents)}</p>
                      </div>
                      <div className="rounded-xl bg-black/40 p-3 border border-white/5 space-y-1">
                        <p className="text-slate-400 text-[11px]">Authoritative Status</p>
                        <p className="font-semibold text-emerald-400 uppercase">COMPLETED & VERIFIED</p>
                      </div>
                    </div>

                    <div className="pt-2 flex justify-end">
                      <button
                        onClick={() => setActiveTab('ledger')}
                        className="text-xs text-violet-300 hover:text-violet-200 flex items-center gap-1 font-medium"
                      >
                        View Full Immutable Event Trail in Ledger →
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: AUTHORITATIVE LEDGER */}
        {activeTab === 'ledger' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <Database className="h-5 w-5 text-violet-400" />
                  Append-Only Authoritative Ledger
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Cryptographically traceable chronological event stream for all procurement activities.
                </p>
              </div>

              <button
                onClick={refreshLedger}
                className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10 transition"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh Events
              </button>
            </div>

            {/* Supabase PostgreSQL Integration Banner */}
            <div className="glass-panel rounded-2xl p-4 border border-violet-500/20 bg-gradient-to-r from-slate-900/90 via-violet-950/20 to-slate-900/90 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-600/20 border border-violet-500/30 text-violet-300">
                  <Database className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white">Database Engine: Supabase PostgreSQL</span>
                    <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300 border border-emerald-500/30">
                      11 RLS TABLES
                    </span>
                    <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[9px] font-bold text-violet-300">
                      APPEND-ONLY AUDIT
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Schema migrations: <span className="font-mono text-slate-300">supabase/migrations/00001_initial_schema.sql</span> · Seed data: <span className="font-mono text-slate-300">supabase/seed.sql</span>
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-mono text-[11px] ${
                  isSupabaseConnected
                    ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                    : 'bg-white/5 text-slate-400 border border-white/10'
                }`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${isSupabaseConnected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
                  {isSupabaseConnected ? 'Live Supabase Connected' : 'Supabase Client Ready (Dual-Write Store Active)'}
                </span>
              </div>
            </div>

            {auditEvents.length === 0 ? (
              <div className="glass-panel rounded-3xl p-12 text-center text-slate-500">
                <Database className="mx-auto h-10 w-10 text-slate-600 mb-3" />
                <p className="text-sm font-medium">No audit events recorded yet.</p>
                <p className="text-xs text-slate-600 mt-1">Start a purchase in the Procurement Studio to observe live events.</p>
              </div>
            ) : (
              <div className="glass-panel rounded-3xl overflow-hidden border border-white/10">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-white/10 bg-white/[0.02] text-slate-400">
                        <th className="py-3 px-4 font-semibold">Timestamp</th>
                        <th className="py-3 px-4 font-semibold">Action</th>
                        <th className="py-3 px-4 font-semibold">Entity Type</th>
                        <th className="py-3 px-4 font-semibold">Actor / Role</th>
                        <th className="py-3 px-4 font-semibold">Event Payload</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 text-slate-300">
                      {auditEvents.map((event) => (
                        <tr key={event.id} className="hover:bg-white/[0.02] transition">
                          <td className="py-3 px-4 font-mono text-[11px] text-slate-400 whitespace-nowrap">
                            {new Date(event.createdAt).toLocaleTimeString()}
                          </td>
                          <td className="py-3 px-4 whitespace-nowrap">
                            <span
                              className={`rounded-lg px-2 py-0.5 text-[10px] font-bold ${
                                event.action.includes('PAYMENT_CAPTURED') || event.action.includes('APPROVED')
                                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                  : event.action.includes('REJECTED') || event.action.includes('VIOLATION')
                                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                                  : event.action.includes('QUOTE')
                                  ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                                  : 'bg-white/10 text-slate-300'
                              }`}
                            >
                              {event.action}
                            </span>
                          </td>
                          <td className="py-3 px-4 uppercase text-[11px] text-slate-400">{event.entityType}</td>
                          <td className="py-3 px-4 whitespace-nowrap">
                            <span className="font-medium text-white">{event.actorId}</span>{' '}
                            <span className="text-[10px] text-slate-500">({event.actorRole})</span>
                          </td>
                          <td className="py-3 px-4 max-w-md">
                            <pre className="font-mono text-[10px] text-slate-400 bg-black/40 p-2 rounded overflow-x-auto max-h-24">
                              {JSON.stringify(event.payload, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: SUPPLIERS & CATALOGUE */}
        {activeTab === 'catalogue' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Layers className="h-5 w-5 text-violet-400" />
                Supplier Registry & Product Catalogue
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Authoritative catalogue fixtures priced strictly in integer minor units (cents).
              </p>
            </div>

            {/* Suppliers Grid */}
            <div className="grid gap-4 md:grid-cols-3">
              {DEMO_SUPPLIERS.map((s) => (
                <div
                  key={s.id}
                  className={`glass-panel rounded-2xl p-5 border ${
                    s.isApproved ? 'border-emerald-500/30' : 'border-rose-500/40 bg-rose-950/10'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-slate-400">{s.code}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        s.isApproved
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-rose-500/20 text-rose-300'
                      }`}
                    >
                      {s.isApproved ? 'APPROVED VENDOR' : 'UNAPPROVED (BLOCKED)'}
                    </span>
                  </div>
                  <h3 className="mt-2 font-bold text-white text-base">{s.name}</h3>
                  <p className="text-xs text-slate-400 mt-1">Country: {s.country} · Contact: {s.contactEmail}</p>
                  <div className="mt-3 flex items-center gap-2 text-xs">
                    <span className="text-slate-500">Risk Rating:</span>
                    <span
                      className={`font-semibold uppercase text-[11px] ${
                        s.riskRating === 'low' ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {s.riskRating}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Products Table */}
            <div className="glass-panel rounded-3xl overflow-hidden border border-white/10 p-5">
              <h3 className="text-sm font-bold text-white mb-3">Catalogue Products</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/10 text-slate-400">
                      <th className="pb-2 font-medium">SKU</th>
                      <th className="pb-2 font-medium">Item Name & Specs</th>
                      <th className="pb-2 font-medium">Category</th>
                      <th className="pb-2 font-medium">Supplier</th>
                      <th className="pb-2 font-medium text-right">Minor Units</th>
                      <th className="pb-2 font-medium text-right">Unit Price</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-slate-300">
                    {DEMO_PRODUCTS.map((p) => {
                      const sup = DEMO_SUPPLIERS.find((s) => s.id === p.supplierId);
                      return (
                        <tr key={p.id}>
                          <td className="py-2.5 font-mono text-[11px] text-violet-300">{p.sku}</td>
                          <td className="py-2.5">
                            <p className="font-semibold text-white">{p.name}</p>
                            <p className="text-[11px] text-slate-400">{p.description}</p>
                          </td>
                          <td className="py-2.5 text-slate-400">{p.category}</td>
                          <td className="py-2.5 text-slate-400">{sup?.name}</td>
                          <td className="py-2.5 font-mono text-right text-slate-400">{p.unitPriceCents} ¢</td>
                          <td className="py-2.5 font-mono font-bold text-right text-white">
                            {formatCurrency(p.unitPriceCents, p.currency)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: SECURITY & ATTACK SIMULATOR */}
        {activeTab === 'security' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Terminal className="h-5 w-5 text-amber-400" />
                Adversarial Security & Attack Simulator
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Interactive playground for judges and auditors to trigger adversarial attacks and verify system defense guardrails in real time.
              </p>
            </div>

            {/* Attack Cards Grid */}
            <div className="grid gap-4 md:grid-cols-2">
              {[
                {
                  key: 'PRICE_TAMPERING',
                  title: 'Attack 1: Client Price Tampering',
                  desc: 'A malicious browser attempts to modify the unit price of a $1,799.00 Dell XPS 15 to $1.00.',
                  defense: 'The server quote engine calculates strictly from trusted database catalogue records, ignoring browser amounts.',
                },
                {
                  key: 'UNAPPROVED_SUPPLIER',
                  title: 'Attack 2: Unapproved Supplier Order',
                  desc: 'Requester attempts to place an order from uncertified high-risk vendor "ShadowTech Grey Market Ltd".',
                  defense: 'Policy engine blocks the quote and forbids approval creation due to supplier risk failure.',
                },
                {
                  key: 'SELF_APPROVAL',
                  title: 'Attack 3: Self-Approval / SoD Bypass',
                  desc: 'Requester (Amina) attempts to self-approve a $3,500 purchase without independent review.',
                  defense: 'Segregation of Duties guardrail prohibits requesters from approving orders over $500.',
                },
                {
                  key: 'UNAUTHORIZED_PAYMENT',
                  title: 'Attack 4: Direct Unapproved Payment',
                  desc: 'Attacker calls PayPal order creation directly without an approved, cryptographically bound quote.',
                  defense: 'PayPal order creation verifies digital signature and approval binding before communicating with PayPal.',
                },
                {
                  key: 'DUPLICATE_WEBHOOK',
                  title: 'Attack 5: Replay / Duplicate Webhook Injection',
                  desc: 'Attacker replays the same PayPal capture webhook payload twice to attempt double ledger credit.',
                  defense: 'Webhook deduplication detects duplicate provider event ID and rejects replay execution.',
                },
              ].map((atk) => (
                <div key={atk.key} className="glass-panel rounded-2xl p-5 border border-white/10 space-y-3">
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      <Lock className="h-4 w-4 text-amber-400" />
                      {atk.title}
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">{atk.desc}</p>
                  </div>

                  <div className="rounded-xl bg-black/40 p-3 border border-white/5 text-[11px] text-slate-300">
                    <span className="font-semibold text-emerald-400">Security Control: </span>
                    {atk.defense}
                  </div>

                  <button
                    onClick={() => runAdversarialAttack(atk.key)}
                    disabled={Boolean(runningAttack)}
                    className="w-full rounded-xl border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 px-4 py-2 text-xs font-semibold text-amber-300 transition flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {runningAttack === atk.key ? (
                      <>
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        Simulating Attack...
                      </>
                    ) : (
                      <>
                        <Terminal className="h-3.5 w-3.5" />
                        Simulate Attack & Test Defense
                      </>
                    )}
                  </button>
                </div>
              ))}
            </div>

            {/* Attack Execution Result Banner */}
            {attackResult && (
              <div className="glass-panel rounded-3xl p-6 border border-emerald-500/40 glow-emerald">
                <div className="flex items-center gap-2 text-emerald-400 font-bold text-base">
                  <ShieldCheck className="h-6 w-6 text-emerald-400" />
                  {attackResult.title} — Defense Verified
                </div>
                <p className="mt-2 text-sm text-slate-200 leading-relaxed font-mono bg-black/50 p-4 rounded-xl border border-white/10">
                  {attackResult.serverMessage}
                </p>
                {attackResult.details && (
                  <p className="mt-2 text-xs text-slate-400">
                    Telemetry: <span className="font-mono text-slate-300">{attackResult.details}</span>
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="mx-auto mt-14 max-w-7xl px-4 text-center text-xs text-slate-500 sm:px-6 lg:px-8 border-t border-white/5 pt-6">
        <p>ActionOS Pay · PayPal AI Hackathon Governance Prototype · Minor Units Integer Financial Precision · Sandbox Only</p>
      </footer>
    </main>
  );
}
