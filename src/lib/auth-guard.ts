// ActionOS Pay: Centralized Enterprise Authentication & Tenant Authorization Guard
// Enforces:
// 1. Bearer session validation via Supabase Auth when configured
// 2. Strict database-backed tenant membership & role boundary enforcement
// 3. Complete caller spoofing prevention
// 4. Safe demo fallback strictly quarantined to unconfigured environments

import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { DEMO_MEMBERS } from './catalog';
import { fetchMembershipFromSupabase, getSupabase, isSupabaseConfigured } from './supabase';
import { TeamMember, UserRole } from './types';

export interface AuthorizationResult {
  authorized: boolean;
  member?: TeamMember;
  errorResponse?: NextResponse;
}

export interface AuthorizeOptions {
  requireExplicitUser?: boolean;
  errorMessage?: string;
}

export async function authorizeRequest(
  req: Request,
  targetBusinessId?: string,
  allowedRoles: UserRole[] = ['requester', 'approver', 'admin'],
  clientSuppliedUserId?: string,
  options?: AuthorizeOptions
): Promise<AuthorizationResult> {
  const resolvedTargetBusinessId =
    targetBusinessId || req.headers.get('x-business-id') || undefined;

  // If an explicit user is required and neither clientSuppliedUserId nor x-demo-user-id is supplied
  if (options?.requireExplicitUser && !clientSuppliedUserId && !req.headers.get('x-demo-user-id') && !req.headers.get('authorization')) {
    const errorMsg =
      options.errorMessage ||
      'approverUserId is required. Anonymous or unauthenticated approvals are prohibited.';
    return {
      authorized: false,
      errorResponse: NextResponse.json(
        { error: errorMsg },
        { status: 401 }
      ),
    };
  }

  const isProduction = process.env.NODE_ENV === 'production';

  // --- Production Security Invariant: Demo mode & demo headers are strictly prohibited in production ---
  if (isProduction) {
    if (req.headers.get('x-demo-user-id')) {
      return {
        authorized: false,
        errorResponse: NextResponse.json(
          {
            error:
              'Forbidden: Demo identity headers (x-demo-user-id) are strictly prohibited in production mode. Real authenticated session required.',
          },
          { status: 403 }
        ),
      };
    }

    if (!isSupabaseConfigured()) {
      return {
        authorized: false,
        errorResponse: NextResponse.json(
          {
            error:
              'Production Configuration Invariant: Supabase authentication is mandatory in production environment. Demo mode fallback is prohibited in production under all circumstances.',
          },
          { status: 500 }
        ),
      };
    }
  }

  // --- 1. Production / Authenticated Mode (Supabase Configured) ---
  if (isSupabaseConfigured()) {
    const authHeader = req.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        authorized: false,
        errorResponse: NextResponse.json(
          {
            error:
              'approverUserId is required. Anonymous or unauthenticated approvals are prohibited. Bearer session token is required when Supabase is configured.',
          },
          { status: 401 }
        ),
      };
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return {
        authorized: false,
        errorResponse: NextResponse.json(
          { error: 'Empty bearer session token provided.' },
          { status: 401 }
        ),
      };
    }

    const supabase = getSupabase();
    if (!supabase) {
      return {
        authorized: false,
        errorResponse: NextResponse.json(
          { error: 'Supabase authentication service unavailable.' },
          { status: 503 }
        ),
      };
    }

    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      const correlationId = randomUUID();
      console.error(
        `[Correlation ID: ${correlationId}] Supabase authentication failure:`,
        authErr?.message || 'Invalid or expired session token.'
      );
      return {
        authorized: false,
        errorResponse: NextResponse.json(
          {
            error: 'Authentication failed: Invalid or expired session token.',
            correlationId,
          },
          { status: 401 }
        ),
      };
    }

    const authenticatedUserId = authData.user.id;

    // Prevent identity spoofing: Client cannot override session identity
    if (clientSuppliedUserId && clientSuppliedUserId !== authenticatedUserId) {
      return {
        authorized: false,
        errorResponse: NextResponse.json(
          {
            error: `Forbidden: Client-supplied approverUserId ("${clientSuppliedUserId}") does not match authenticated user session ("${authenticatedUserId}").`,
          },
          { status: 403 }
        ),
      };
    }

    // Resolve active membership from database (dynamic tenant resolution if targetBusinessId omitted)
    const member = await fetchMembershipFromSupabase(authenticatedUserId, resolvedTargetBusinessId);
    if (!member) {
      return {
        authorized: false,
        errorResponse: NextResponse.json(
          {
            error: `Approver identity "${authenticatedUserId}" could not be verified in organization records.`,
          },
          { status: 403 }
        ),
      };
    }

    // Strict tenant boundary check if target organization was specified
    if (resolvedTargetBusinessId && member.businessId !== resolvedTargetBusinessId) {
      return {
        authorized: false,
        errorResponse: NextResponse.json(
          {
            error: `Approver "${member.userName}" does not belong to business "${resolvedTargetBusinessId}". Cross-tenant operations are strictly prohibited.`,
          },
          { status: 403 }
        ),
      };
    }

    // Role-based access control
    if (!allowedRoles.includes(member.role)) {
      return {
        authorized: false,
        errorResponse: NextResponse.json(
          {
            error: `User "${member.userName}" holds role "${member.role}". Authorized roles: ${allowedRoles.join(', ')}.`,
          },
          { status: 403 }
        ),
      };
    }

    return { authorized: true, member };
  }

  // --- 2. Production Security Gate: Prohibit demo fallback in production under all circumstances ---
  if (isProduction) {
    return {
      authorized: false,
      errorResponse: NextResponse.json(
        {
          error:
            'Production Configuration Invariant: Supabase authentication is mandatory in production environment. Demo mode fallback is prohibited in production under all circumstances.',
        },
        { status: 500 }
      ),
    };
  }

  // --- 3. Demo Mode (Local / Development / Test / Sandbox Only) ---
  const resolvedUserId =
    clientSuppliedUserId ||
    req.headers.get('x-demo-user-id') ||
    DEMO_MEMBERS.find((m) => allowedRoles.includes(m.role))?.userId;

  if (!resolvedUserId) {
    return {
      authorized: false,
      errorResponse: NextResponse.json(
        { error: 'approverUserId is required. Anonymous or unauthenticated approvals are prohibited.' },
        { status: 401 }
      ),
    };
  }

  const member = DEMO_MEMBERS.find((m) => m.userId === resolvedUserId);
  if (!member) {
    return {
      authorized: false,
      errorResponse: NextResponse.json(
        { error: `Approver identity "${resolvedUserId}" could not be verified in organization records.` },
        { status: 403 }
      ),
    };
  }

  if (resolvedTargetBusinessId && member.businessId !== resolvedTargetBusinessId) {
    return {
      authorized: false,
      errorResponse: NextResponse.json(
        {
          error: `Approver "${member.userName}" does not belong to business "${resolvedTargetBusinessId}". Cross-tenant operations are strictly prohibited.`,
        },
        { status: 403 }
      ),
    };
  }

  if (!allowedRoles.includes(member.role)) {
    return {
      authorized: false,
      errorResponse: NextResponse.json(
        {
          error: `User "${member.userName}" holds role "${member.role}". Authorized roles: ${allowedRoles.join(', ')}.`,
        },
        { status: 403 }
      ),
    };
  }

  return { authorized: true, member };
}
