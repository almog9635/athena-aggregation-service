import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';
import { join } from 'path';

const YAML_CONFIG_FILENAME = 'config.yaml';
const JSON_CONFIG_FILENAME = 'config.json';

export default () => {
    const isLocal = process.env.NODE_ENV !== 'production';

    if (!isLocal) {
        const yamlPath = join(process.cwd(), YAML_CONFIG_FILENAME);
        if (existsSync(yamlPath)) {
            return yaml.load(readFileSync(yamlPath, 'utf8')) as Record<string, any>;
        }
    }

    // Fallback to local JSON configuration
    const jsonPath = join(process.cwd(), JSON_CONFIG_FILENAME);
    if (existsSync(jsonPath)) {
        return JSON.parse(readFileSync(jsonPath, 'utf8'));
    }

    return {}; // default empty config if neither found
};
