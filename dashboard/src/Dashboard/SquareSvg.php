<?php

declare(strict_types=1);

namespace App\Dashboard;

/**
 * Centers an SVG on the smallest square around it, so non-square logos work as icons
 * (favicons and app icons are always square and would otherwise be stretched or cropped
 * differently per browser).
 *
 * The original <svg> is nested unchanged into a square outer <svg>, offset by half the
 * difference of width and height.
 */
final class SquareSvg
{
    private const string NS = 'http://www.w3.org/2000/svg';

    /** Returns the squared SVG, or the input unchanged if it is square already or its size is unknown. */
    public static function square(string $svg): string
    {
        $doc = new \DOMDocument();
        // LIBXML_NONET: never fetch anything from the network while parsing
        if (!@$doc->loadXML($svg, \LIBXML_NONET | \LIBXML_NOBLANKS)) {
            return $svg;
        }
        $root = $doc->documentElement;
        if (null === $root || 'svg' !== $root->localName) {
            return $svg;
        }

        $box = self::viewBox($root);
        if (null === $box) {
            return $svg;
        }
        [$minX, $minY, $width, $height] = $box;
        if ($width <= 0 || $height <= 0 || abs($width - $height) < 1e-9) {
            return $svg;
        }

        $size = max($width, $height);
        $square = new \DOMDocument('1.0', 'UTF-8');
        $outer = $square->createElementNS(self::NS, 'svg');
        $outer->setAttribute('viewBox', '0 0 '.self::num($size).' '.self::num($size));
        $square->appendChild($outer);

        /** @var \DOMElement $inner */
        $inner = $square->importNode($root, true);
        $inner->setAttribute('viewBox', implode(' ', array_map(self::num(...), $box)));
        $inner->setAttribute('x', self::num(($size - $width) / 2));
        $inner->setAttribute('y', self::num(($size - $height) / 2));
        $inner->setAttribute('width', self::num($width));
        $inner->setAttribute('height', self::num($height));
        $outer->appendChild($inner);

        return $square->saveXML($outer);
    }

    /**
     * Size of the drawing: the viewBox, otherwise width/height in user units (px).
     *
     * @return array{float, float, float, float}|null
     */
    private static function viewBox(\DOMElement $root): ?array
    {
        $parts = preg_split('/[\s,]+/', trim($root->getAttribute('viewBox')), -1, \PREG_SPLIT_NO_EMPTY);
        if (4 === \count($parts) && array_filter($parts, is_numeric(...)) === $parts) {
            return array_map(floatval(...), $parts);
        }

        $width = self::length($root->getAttribute('width'));
        $height = self::length($root->getAttribute('height'));

        return null !== $width && null !== $height ? [0.0, 0.0, $width, $height] : null;
    }

    /** Parses absolute lengths without unit or in px; relative units (%, em) cannot be resolved. */
    private static function length(string $value): ?float
    {
        return preg_match('/^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/', $value, $m) ? (float) $m[1] : null;
    }

    private static function num(float $value): string
    {
        return rtrim(rtrim(\sprintf('%.4F', $value), '0'), '.');
    }
}
