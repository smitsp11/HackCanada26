import OperaShell from "@/components/opera/OperaShell";

interface HomePageProps {
  searchParams?: Promise<{ state?: string }>;
}

export default async function Home({ searchParams }: HomePageProps) {
  const params = (await searchParams) ?? {};
  const state = typeof params.state === "string" ? params.state : null;

  return (
    <main className="relative min-h-screen w-full overflow-hidden">
      <OperaShell testStateKey={state} />
    </main>
  );
}
