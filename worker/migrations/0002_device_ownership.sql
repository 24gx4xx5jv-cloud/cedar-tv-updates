ALTER TABLE sync_devices
ADD COLUMN is_owner INTEGER CHECK (is_owner IN (0, 1));

UPDATE sync_devices
SET is_owner = 0;

UPDATE sync_devices AS device
SET is_owner = 1
WHERE device.device_id = (
    SELECT candidate.device_id
    FROM sync_devices AS candidate
    WHERE candidate.space_id = device.space_id
    ORDER BY candidate.created_at_ms ASC, candidate.device_id ASC
    LIMIT 1
);
