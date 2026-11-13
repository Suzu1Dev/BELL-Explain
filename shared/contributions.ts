export type ContributionExperience = 'newcomer' | 'comfortable' | 'experienced';
export interface ContributionPreferences {
  topics: string;
  languages: string[];
  experience: ContributionExperience;
  priority: 'balanced' | 'easy' | 'impact';
  popularity: 'any' | 'growing' | 'popular';
  useKnowledge: boolean;
  limit: number;
}
export interface ContributionEvidence {
  id: string;
  kind: 'repository' | 'guidelines' | 'readme' | 'issue' | 'comment' | 'pull_request';
  title: string;
  url: string;
  text: string;
  checkedAt: string;
}
export interface ContributionCandidate {
  id: string;
  repository: { fullName: string; url: string; description: string; language: string | null; stars: number; forks: number; openIssues: number; pushedAt: string; license: string | null; archived: boolean; topics: string[] };
  issue: { number: number; title: string; url: string; body: string; labels: string[]; assignees: string[]; comments: number; reactions: number; createdAt: string; updatedAt: string; state: string; locked: boolean };
  evidence: ContributionEvidence[];
  checks: { guidelines: 'found' | 'not_found' | 'unavailable'; comments: 'checked' | 'none' | 'unavailable'; linkedPullRequests: 'found' | 'none_seen' | 'unavailable'; pullRequestUrls: string[]; warnings: string[] };
}
export interface ContributionResearch {
  candidates: ContributionCandidate[];
  warnings: string[];
  searchedAt: string;
  repositoryCount: number;
  issueCount: number;
  requestCount: number;
  queries: string[];
}
export interface ContributionAssessment {
  candidateId: string;
  fit: string;
  demand: string;
  difficulty: 'easy' | 'moderate' | 'hard';
  difficultyReason: string;
  contributionRules: string[];
  firstSteps: string[];
  acceptanceChecks: string[];
  risks: string[];
  effort: string;
  evidenceIds: string[];
  scores: { fit: number; demand: number; accessibility: number; activity: number };
}
export interface ContributionRecommendation extends ContributionAssessment {
  candidate: ContributionCandidate;
  score: number;
  bookmarked: boolean;
}
export interface ContributionReport {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stage: 'plan' | 'discover' | 'read' | 'evaluate' | 'review' | 'complete';
  message: string;
  preferences: ContributionPreferences;
  profileTags: string[];
  model: string;
  createdAt: string;
  updatedAt: string;
  checkedAt?: string;
  summary: string;
  recommendations: ContributionRecommendation[];
  warnings: string[];
  coverage?: { repositories: number; issues: number; requests: number; queries: string[] };
  error?: string;
}
export interface ContributionStatus {
  configured: boolean;
  model: string;
  message: string;
  profileTags: string[];
  github: { mode: 'cli' | 'token' | 'public'; message: string };
  activeReportId?: string;
}
