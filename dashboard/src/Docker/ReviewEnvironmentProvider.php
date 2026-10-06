<?php

declare(strict_types=1);

namespace App\Docker;

use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\Attribute\Target;
use Symfony\Contracts\Cache\CacheInterface;
use Symfony\Contracts\Cache\ItemInterface;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * Reads review containers from the read-only Docker API (docker-socket-proxy, CONTAINERS=1)
 * and groups them into
 *  - merge request environments (per project and MR IID) and
 *  - protected branch deployments (review.type=branch, per project and branch).
 *
 * Results are cached for a few seconds, so any number of open dashboards cause at most one
 * round of Docker API calls per TTL. If the API is unreachable, the last successful result is
 * served with ok=false, so clients keep showing data instead of an empty list.
 */
final class ReviewEnvironmentProvider
{
    private const string CACHE_KEY = 'environments';
    private const string LAST_GOOD_KEY = 'environments.last_good';
    private const int TTL = 5;

    public function __construct(
        #[Target('docker.client')] private readonly HttpClientInterface $docker,
        #[Target('review.cache')] private readonly CacheInterface $cache,
        private readonly LoggerInterface $logger,
    ) {
    }

    /**
     * @return array{ok: bool, error: ?string, fetched_at: ?string, branches: list<array<string, mixed>>, environments: list<array<string, mixed>>}
     */
    public function fetch(): array
    {
        return $this->cache->get(self::CACHE_KEY, function (ItemInterface $item): array {
            $item->expiresAfter(self::TTL);

            try {
                $result = [
                    'ok' => true,
                    'error' => null,
                    'fetched_at' => (new \DateTimeImmutable())->format(\DATE_ATOM),
                    ...$this->group($this->listContainers()),
                ];
            } catch (ExceptionInterface|\JsonException $e) {
                $this->logger->error('Docker API request failed: {message}', ['message' => $e->getMessage(), 'exception' => $e]);
                $last = $this->cache->get(self::LAST_GOOD_KEY, static fn (): ?array => null);

                return [
                    'ok' => false,
                    'error' => 'Docker-API nicht erreichbar',
                    'fetched_at' => $last['fetched_at'] ?? null,
                    'branches' => $last['branches'] ?? [],
                    'environments' => $last['environments'] ?? [],
                ];
            }

            // beta=INF forces the value to be recomputed and stored
            $this->cache->get(self::LAST_GOOD_KEY, static fn (): array => $result, \INF);

            return $result;
        });
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function listContainers(): array
    {
        // Filter on the Docker side, so only review containers are transferred. Docker ANDs
        // multiple label filters, so MR and branch containers need one request each; both
        // run concurrently. Containers carrying both labels are deduplicated by ID.
        $responses = array_map(
            fn (string $label) => $this->docker->request('GET', '/containers/json', [
                'query' => [
                    'all' => '1',
                    'filters' => json_encode(['label' => [$label]], \JSON_THROW_ON_ERROR),
                ],
            ]),
            ['review.mr', 'review.type=branch'],
        );

        $containers = [];
        foreach ($responses as $response) {
            foreach (json_decode($response->getContent(), true, 512, \JSON_THROW_ON_ERROR) as $c) {
                if (isset($c['Id'])) {
                    $containers[$c['Id']] = $c;
                } else {
                    $containers[] = $c;
                }
            }
        }

        return array_values($containers);
    }

    /**
     * Groups all containers of one environment: the app carries the metadata, every other
     * container with review.role=service becomes a sub-service (link and/or status).
     *
     * @param list<array<string, mixed>> $containers
     *
     * @return array{branches: list<array<string, mixed>>, environments: list<array<string, mixed>>}
     */
    private function group(array $containers): array
    {
        $branches = [];
        $mrs = [];
        foreach ($containers as $c) {
            $l = $c['Labels'] ?? [];
            $project = $l['review.project'] ?? '';

            if ('branch' === ($l['review.type'] ?? 'mr')) {
                $branch = $l['review.branch'] ?? '';
                if ('' === $branch) {
                    continue;
                }
                $group = &$branches[$project."\0".$branch];
                $group ??= ['project' => $project, 'branch' => $branch, 'app' => null, 'services' => []];
            } else {
                $mr = (int) ($l['review.mr'] ?? 0);
                if (0 === $mr) {
                    continue;
                }
                // MR IIDs are only unique per project
                $group = &$mrs[$project."\0".$mr];
                $group ??= ['project' => $project, 'mr' => $mr, 'app' => null, 'services' => []];
            }

            if ('app' === ($l['review.role'] ?? 'app')) {
                $group['app'] = [
                    'title' => $l['review.title'] ?? '',
                    'branch' => $l['review.branch'] ?? '',
                    'branch_url' => $l['review.branch_url'] ?? '',
                    'commit' => $l['review.commit'] ?? '',
                    'author' => $l['review.author'] ?? '',
                    'url' => $l['review.url'] ?? '',
                    'mr_url' => isset($group['mr']) ? ($l['review.mr_url'] ?? '') : '',
                    'deployed_at' => $l['review.deployed_at'] ?? '',
                    'state' => $c['State'] ?? 'unknown',
                    'status' => $c['Status'] ?? '',
                ];
            } else {
                $group['services'][] = [
                    'name' => $l['review.service.name'] ?? ($l['com.docker.compose.service'] ?? '?'),
                    'url' => $l['review.service.url'] ?? '',
                    'order' => (int) ($l['review.service.order'] ?? 100),
                    'state' => $c['State'] ?? 'unknown',
                    'status' => $c['Status'] ?? '',
                ];
            }
            unset($group);
        }

        $branches = array_map(self::sortServices(...), array_values($branches));
        usort($branches, static fn (array $a, array $b): int => [$a['project'], $a['branch']] <=> [$b['project'], $b['branch']]);

        $mrs = array_map(self::sortServices(...), array_values($mrs));
        usort($mrs, static fn (array $a, array $b): int => [$a['project'], $b['mr']] <=> [$b['project'], $a['mr']]);

        return ['branches' => $branches, 'environments' => $mrs];
    }

    /**
     * @param array<string, mixed> $group
     *
     * @return array<string, mixed>
     */
    private static function sortServices(array $group): array
    {
        usort($group['services'], static fn (array $a, array $b): int => [$a['order'], $a['name']] <=> [$b['order'], $b['name']]);

        return $group;
    }
}
