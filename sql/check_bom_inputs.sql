-- Check inputs for BOM Explosion
SELECT 'demand_fg' as table_name, COUNT(*) as row_count FROM demand_fg WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
UNION ALL
SELECT 'bom_edges', COUNT(*) FROM bom_edges WHERE user_id = '291075be-3bee-43ff-a296-17c8eecd26a1';

-- Check if they match on material_code
SELECT 
    d.material_code as fg_material, 
    COUNT(b.child_material) as bom_components_count
FROM demand_fg d
LEFT JOIN bom_edges b ON d.material_code = b.parent_material
WHERE d.user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
GROUP BY d.material_code;
