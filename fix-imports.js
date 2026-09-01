const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.resolve(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      results.push(file);
    }
  });
  return results;
}

const files = walk('src');
files.forEach(file => {
  if (file.endsWith('.ts') || file.endsWith('.tsx')) {
    let content = fs.readFileSync(file, 'utf8');
    let modified = false;
    
    // Replace import { prisma } from "../server";
    if (content.includes('../server')) {
      content = content.replace(/import\s+\{\s*prisma\s*\}\s+from\s+['"]\.\.\/server['"];?/g, 'import { prisma } from "../utils/prisma";');
      modified = true;
    }
    
    // Replace import { prisma } from "../../server";
    if (content.includes('../../server')) {
      content = content.replace(/import\s+\{\s*prisma\s*\}\s+from\s+['"]\.\.\/\.\.\/server['"];?/g, 'import { prisma } from "../../utils/prisma";');
      modified = true;
    }
    
    // Replace import { prisma } from "./server";
    if (content.includes('./server')) {
      content = content.replace(/import\s+\{\s*prisma\s*\}\s+from\s+['"]\.\/server['"];?/g, 'import { prisma } from "./utils/prisma";');
      modified = true;
    }
    
    if (modified) {
      fs.writeFileSync(file, content);
      console.log('Updated ' + file);
    }
  }
});
