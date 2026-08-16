import type { SupabaseClient } from '@supabase/supabase-js';

export type LearningKind = 'case_study' | 'simulation' | 'tutor';
export type LearningStatus = 'queued' | 'processing' | 'ready' | 'failed';

export interface LearningRequest {
  id: string;
  kind: LearningKind;
  status: LearningStatus;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
}

export async function requestLearningArtifact(
  client: SupabaseClient,
  userId: string,
  courseId: string,
  kind: LearningKind,
  request: Record<string, unknown>
): Promise<LearningRequest> {
  const fingerprint = await requestFingerprint({ userId, courseId, kind, request });
  const { data: existing } = await client
    .from('ai_learning_requests')
    .select('id,kind,status,request,result,error_message,created_at')
    .eq('user_id', userId)
    .eq('kind', kind)
    .eq('fingerprint', fingerprint)
    .eq('status', 'ready')
    .maybeSingle();
  if (existing) return existing as LearningRequest;
  const { data, error } = await client
    .from('ai_learning_requests')
    .insert({ user_id: userId, course_id: courseId, kind, request, fingerprint })
    .select('id,kind,status,request,result,error_message,created_at')
    .single();
  if (error) throw error;
  return data as LearningRequest;
}

export async function listLearningRequests(
  client: SupabaseClient,
  courseId: string,
  kind: LearningKind
): Promise<LearningRequest[]> {
  const { data, error } = await client
    .from('ai_learning_requests')
    .select('id,kind,status,request,result,error_message,created_at')
    .eq('course_id', courseId)
    .eq('kind', kind)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return (data ?? []) as LearningRequest[];
}

export interface TutorConversation {
  id: string;
  title: string;
  context: Record<string, unknown>;
}

export interface TutorMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  source_chunk_ids: string[];
  task: string | null;
  model_tier: string | null;
  created_at: string;
}

export async function getOrCreateConversation(
  client: SupabaseClient,
  userId: string,
  courseId: string,
  context: Record<string, unknown>
): Promise<TutorConversation> {
  const { data: existing } = await client
    .from('tutor_conversations')
    .select('id,title,context')
    .eq('course_id', courseId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return existing as TutorConversation;
  const { data, error } = await client
    .from('tutor_conversations')
    .insert({ user_id: userId, course_id: courseId, context })
    .select('id,title,context')
    .single();
  if (error) throw error;
  return data as TutorConversation;
}

export async function listTutorMessages(
  client: SupabaseClient,
  conversationId: string
): Promise<TutorMessage[]> {
  const { data, error } = await client
    .from('tutor_messages')
    .select('id,role,content,source_chunk_ids,task,model_tier,created_at')
    .eq('conversation_id', conversationId)
    .order('created_at');
  if (error) throw error;
  return (data ?? []) as TutorMessage[];
}

export async function sendTutorMessage(
  client: SupabaseClient,
  userId: string,
  courseId: string,
  conversationId: string,
  content: string,
  context: Record<string, unknown>
): Promise<void> {
  const { error } = await client.from('tutor_messages').insert({
    conversation_id: conversationId,
    user_id: userId,
    role: 'user',
    content,
  });
  if (error) throw error;
  await requestLearningArtifact(client, userId, courseId, 'tutor', {
    conversationId,
    message: content,
    ...context,
    nonce: new Date().toISOString(),
  });
}

async function requestFingerprint(value: unknown): Promise<string> {
  const text = JSON.stringify(value);
  if (globalThis.crypto?.subtle) {
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fallback-${(hash >>> 0).toString(16)}`;
}
