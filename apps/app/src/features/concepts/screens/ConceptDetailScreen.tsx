import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { CONCEPT_RELATIONSHIP_LABELS, CONCEPT_TYPE_LABELS } from '@avidia/domain';
import { describeLocator } from '@avidia/rag';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { fetchConceptDetail, type ConceptDetail, type ConceptEvidenceRow } from '../conceptsApi';

/**
 * Concept detail with source evidence (M6 spec Q/K). Every concept is
 * displayed WITH where it came from — "Found in: <document> — slide 17" —
 * grouped by document, so students can verify the platform's claims against
 * their own material. Only course-sourced knowledge is shown here; nothing on
 * this screen is general AI knowledge presented as course content.
 */

export function ConceptDetailScreen({
  courseId,
  conceptId,
}: {
  courseId: string;
  conceptId: string;
}) {
  const { user } = useAuth();
  const [detail, setDetail] = useState<ConceptDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setLoading(false);
      return;
    }
    try {
      const found = await fetchConceptDetail(client, conceptId);
      setDetail(found);
      setError(found ? null : 'This concept could not be found.');
    } catch {
      setError('We could not load this concept. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [user, conceptId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (loading) {
    return (
      <Screen title="Concept">
        <Text style={styles.muted}>Loading concept…</Text>
      </Screen>
    );
  }
  if (!detail) {
    return (
      <Screen title="Concept">
        <ErrorBanner message={error} />
        <SecondaryButton
          label="Back to concepts"
          onPress={() => router.replace(`/course/${courseId}/concepts`)}
        />
      </Screen>
    );
  }

  const { concept, aliases, evidence, relationships } = detail;
  const byDocument = groupEvidence(evidence);

  return (
    <Screen title={concept.canonical_name}>
      <ErrorBanner message={error} />
      <View style={styles.card}>
        <Text style={styles.typeBadge}>{CONCEPT_TYPE_LABELS[concept.concept_type]}</Text>
        {aliases.length > 0 ? (
          <Text style={styles.meta}>
            Also called: {aliases.map((alias) => alias.alias).join(', ')}
          </Text>
        ) : null}
        {concept.summary ? <Text style={styles.summary}>{concept.summary}</Text> : null}
      </View>

      <Text style={styles.sectionTitle}>Found in your materials</Text>
      {byDocument.length === 0 ? (
        <Text style={styles.muted}>
          No source locations recorded for this concept yet. This can happen briefly while materials
          are re-processing.
        </Text>
      ) : (
        byDocument.map((group) => (
          <View key={group.documentId} style={styles.card}>
            <Text style={styles.documentName}>{group.documentName}</Text>
            <Text style={styles.meta}>{group.locations.join('; ')}</Text>
          </View>
        ))
      )}

      {relationships.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>Related concepts in this course</Text>
          {relationships.map((relationship) => (
            <View key={relationship.id} style={styles.card}>
              <Text style={styles.meta}>
                {relationship.direction === 'outgoing'
                  ? `${concept.canonical_name} ${CONCEPT_RELATIONSHIP_LABELS[relationship.relationship_type]} ${relationship.other_name}`
                  : `${relationship.other_name} ${CONCEPT_RELATIONSHIP_LABELS[relationship.relationship_type]} ${concept.canonical_name}`}
              </Text>
              <SecondaryButton
                label={`Open ${relationship.other_name}`}
                onPress={() => router.push(`/course/${courseId}/concept/${relationship.other_id}`)}
              />
            </View>
          ))}
        </>
      ) : null}

      <SecondaryButton
        label="Back to concepts"
        onPress={() => router.push(`/course/${courseId}/concepts`)}
      />
    </Screen>
  );
}

interface EvidenceGroup {
  documentId: string;
  documentName: string;
  locations: string[];
}

/** Group evidence rows by document, with deduplicated readable locators. */
export function groupEvidence(evidence: ConceptEvidenceRow[]): EvidenceGroup[] {
  const groups = new Map<string, EvidenceGroup>();
  for (const row of evidence) {
    const location = row.locator ? describeLocator(row.locator) : 'in this document';
    const existing = groups.get(row.document_id);
    if (existing) {
      if (!existing.locations.includes(location)) {
        existing.locations.push(location);
      }
    } else {
      groups.set(row.document_id, {
        documentId: row.document_id,
        documentName: row.document_name,
        locations: [location],
      });
    }
  }
  return [...groups.values()];
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(4),
    gap: spacing(2),
    marginBottom: spacing(3),
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    marginTop: spacing(3),
    marginBottom: spacing(2),
  },
  typeBadge: { fontSize: 13, color: colors.primary, fontWeight: '600' },
  summary: { fontSize: 15, color: colors.text, lineHeight: 22 },
  documentName: { fontSize: 15, fontWeight: '600', color: colors.text },
  meta: { fontSize: 14, color: colors.textMuted, lineHeight: 20 },
});
